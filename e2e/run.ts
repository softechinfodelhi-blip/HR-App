// End-to-end check of the three flows, in a real browser against the real server and a real database.
//
//   npm run build && npm run e2e
//
// What it does: makes a fresh database (sbm_hr_e2e) on the local Postgres, seeds the demo offices,
// starts the server as if today were Tue 1 Dec 2026, sends a whole November of punches for Office 1
// through the terminal listener, then clicks through the app in Chrome or Edge:
//   1. an employee applies for leave and the head approves it (with Undo)
//   2. the head resolves the missing punches and locks November
//   3. the head adds an employee, who sets a password and signs in
// Screenshots are saved in e2e/screenshots.
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import puppeteer, { type Page } from 'puppeteer-core';
import { dataDir, DEV_DB, devDbUrl, startPostgres } from '../server/scripts/dev-db';
import { isWeeklyOff } from '../server/src/services/calendar';

const PORT = 3100; const ADMS_PORT = 8181;
const BASE = `http://localhost:${PORT}`;
const DB = 'sbm_hr_e2e';
const SHOTS = path.resolve('e2e/screenshots');
const NEW_EMAIL = 'asha.rao@sbm.example';
const NEW_PASSWORD = 'first-day-2026';
if (existsSync('.env')) process.loadEnvFile('.env'); // for the seeded admin's sign in
const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: devDbUrl(DB), DIRECT_URL: devDbUrl(DB), PORT: String(PORT), ADMS_PORT: String(ADMS_PORT), APP_URL: BASE, SMTP_HOST: '', SBM_FAKE_NOW: '2026-12-01T10:00:00+05:30' };

const log = (s: string) => console.log(s);
const step = (s: string) => console.log(`   ${s}`);
function check(ok: unknown, what: string): asserts ok { if (!ok) throw new Error(`FAILED: ${what}`); step(`ok  ${what}`); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const portOpen = (port: number) => new Promise<boolean>(res => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });

// ---------- the page helpers: everything is found by the words on screen ----------
/** Clicks the first visible element of `tag` whose text is (or starts with) `text`. */
async function click(page: Page, text: string, tag = 'button, a') {
  const ok = await page.evaluate((text, tag) => {
    const els = [...document.querySelectorAll<HTMLElement>(tag)].filter(e => e.offsetParent !== null && !(e as HTMLButtonElement).disabled);
    // Compared without case: CSS may show a label in capitals.
    const t = text.toLowerCase(); const of = (e: HTMLElement) => e.innerText.trim().toLowerCase();
    const el = els.find(e => of(e) === t) ?? els.find(e => of(e).startsWith(t)) ?? els.find(e => of(e).includes(t));
    if (!el) return false;
    el.click(); return true;
  }, text, tag);
  if (!ok) throw new Error(`Could not find "${text}" to click`);
}
/** Waits until the page shows these words. */
async function see(page: Page, text: string, timeout = 15000) {
  try { await page.waitForFunction(t => document.body.innerText.toLowerCase().includes(t), { timeout }, text.toLowerCase()); }
  catch { throw new Error(`Expected to see "${text}". The page shows:\n${(await page.evaluate(() => document.body.innerText)).slice(0, 900)}`); }
}
const gone = (page: Page, text: string) => page.waitForFunction(t => !document.body.innerText.toLowerCase().includes(t), { timeout: 15000 }, text.toLowerCase());
/** Fills the field under a label (React needs the native setter, then an input event). */
async function fill(page: Page, label: string, value: string) {
  const ok = await page.evaluate((label, value) => {
    const labels = [...document.querySelectorAll<HTMLElement>('label, .field, div')].filter(e => e.offsetParent !== null);
    const holder = labels.filter(e => e.innerText.trim().toLowerCase().startsWith(label.toLowerCase()) && e.querySelector('input, textarea')).sort((a, b) => a.innerText.length - b.innerText.length)[0];
    const el = holder?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, label, value);
  if (!ok) throw new Error(`Could not find the field "${label}"`);
}
let shot = 0;
async function snap(page: Page, name: string) { await sleep(500); await page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}.png`) as `${string}.png` }); }
async function signIn(page: Page, email: string, password = 'demo1234') {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await see(page, 'Sign in');
  await fill(page, 'Email', email); await fill(page, 'Password', password);
  await click(page, 'Sign in', 'button[type=submit]');
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 });
}
async function signOut(page: Page) {
  await page.click('button[aria-label="Your menu"]');
  await click(page, 'Sign out');
  await see(page, 'Use your work email.');
}
/** Calls the API from inside the page, with the signed-in person's cookie. */
const apiGet = <T>(page: Page, url: string) => page.evaluate(async u => (await fetch(u)).json(), url) as Promise<T>;

// ---------- data ----------
async function sendNovember(prisma: PrismaClient) {
  const staff = await prisma.employee.findMany({ where: { office: { number: 1 } }, select: { terminalUserId: true, name: true } });
  const lines: string[] = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-11-${String(d).padStart(2, '0')}`;
    if (isWeeklyOff(date)) continue;
    for (const e of staff) {
      const id = e.terminalUserId!;
      if (id === '112' && d === 5) continue;                                                      // Suresh: absent
      const inTime = id === '117' && d === 4 ? '09:20:00' : `08:5${Number(id) % 9}:1${d % 10}`;   // Priya: late once
      lines.push(`${id}\t${date} ${inTime}\t0\t1\t0\t0\t0`);
      if ((id === '108' && d === 21) || (id === '106' && d === 20)) continue;                     // Karan and Sneha: no punch out
      lines.push(`${id}\t${date} 18:0${Number(id) % 9}:2${d % 10}\t1\t1\t0\t0\t0`);
    }
  }
  for (let i = 0; i < lines.length; i += 250) {
    const res = await fetch(`http://localhost:${ADMS_PORT}/iclock/cdata?SN=DEMO0001&table=ATTLOG&Stamp=${i + 250}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: lines.slice(i, i + 250).join('\n') });
    const text = (await res.text()).trim();
    if (!text.startsWith('OK: ')) throw new Error(`The terminal listener answered "${text}"`);
  }
  return { people: staff.length, punches: lines.length };
}

// ---------- the three flows ----------
async function flow1(page: Page) {
  log('\n1. An employee applies for leave and the office head approves it');
  await signIn(page, 'priya.nair@sbm.example');
  await see(page, 'Leave balance');
  await page.goto(`${BASE}/me/leave/apply`, { waitUntil: 'networkidle0' });
  await see(page, 'Working days');
  await fill(page, 'Reason', 'Family function in Kochi');
  await page.waitForFunction(() => /CL left after this/.test(document.body.innerText), { timeout: 10000 });
  await snap(page, 'flow1-apply-leave');
  await click(page, 'Send request');
  await see(page, 'Request sent');
  check(true, 'Priya sent a CL request for Wed 2 Dec');
  await page.goto(`${BASE}/me/leave`, { waitUntil: 'networkidle0' });
  await see(page, 'Pending');
  await signOut(page);

  await signIn(page, 'vikram.singh@sbm.example');
  await see(page, 'Waiting for you');
  await see(page, 'Priya Nair');
  await see(page, 'Family function in Kochi');
  await snap(page, 'flow1-head-home-queue');
  await click(page, 'Approve');
  await see(page, 'Approved: Priya Nair');   // the toast
  check(true, 'the head approved it with one click and the toast offers Undo');
  await snap(page, 'flow1-approved-toast');
  await click(page, 'Undo');
  await see(page, 'Family function in Kochi');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Approve'), { timeout: 10000 });
  check(true, 'Undo put the request back to pending');
  await click(page, 'Approve');
  await see(page, 'Approved: Priya Nair');
  await gone(page, 'Family function in Kochi');
  const decided = await apiGet<{ items: { status: string; employeeName: string; decidedByName: string }[] }>(page, '/api/requests?kind=leave&status=decided');
  check(decided.items.some(r => r.employeeName === 'Priya Nair' && r.status === 'approved' && r.decidedByName === 'Vikram Singh'), 'the server has the leave as approved by Vikram Singh');
  await signOut(page);

  await signIn(page, 'priya.nair@sbm.example');
  await page.goto(`${BASE}/me/leave`, { waitUntil: 'networkidle0' });
  await see(page, 'Approved by Vikram Singh');
  const bal = await apiGet<{ cl: { balance: number } }>(page, '/api/me/balances');
  check(bal.cl.balance === 11, `Priya sees it approved and her CL balance went from 12 to ${bal.cl.balance}`);
  await page.click('button[aria-label^="Notifications"]');
  await see(page, 'Your CL for Wed 2 Dec was approved');
  check(true, 'Priya got the notification');
  await snap(page, 'flow1-employee-sees-approval');
  await page.keyboard.press('Escape');
  await signOut(page);
}

async function flow2(page: Page) {
  log('\n2. The office head resolves the missing punches and locks November');
  await signIn(page, 'vikram.singh@sbm.example');
  await page.goto(`${BASE}/payroll`, { waitUntil: 'networkidle0' });
  await see(page, 'Month-end checklist');
  await see(page, 'Resolve 2 missing punches');
  await snap(page, 'flow2-checklist');
  const lockDisabled = () => page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.includes('Hold to lock'))?.disabled);
  check(await lockDisabled(), 'the lock is closed while punches are missing');

  for (const n of [2, 1]) {
    await click(page, 'Enter the out time');
    await see(page, 'Raw punches from the terminal');
    await click(page, 'Correct this day');
    await fill(page, 'Out time', '18:05');
    await fill(page, 'Reason', 'Confirmed with the guard register');
    if (n === 2) await snap(page, 'flow2-enter-out-time');
    await click(page, 'Save correction');
    await see(page, 'Manual correction');
    await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>('button[aria-label="Close"]')].filter(b => b.offsetParent !== null).at(-1)!.click(); });
    await see(page, n === 2 ? 'Resolve 1 missing punch' : 'No missing punches');
  }
  check(true, 'both missing punches were resolved by the head, with a reason');
  await see(page, 'No pending requests for November');
  await click(page, 'Mark as reviewed');
  await see(page, 'Salaries reviewed by Vikram Singh');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.innerText.includes('Hold to lock'))?.disabled === false, { timeout: 10000 });
  await snap(page, 'flow2-ready-to-lock');

  // Press and hold for a second: the one deliberate action in the app.
  const box = await (await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.innerText.includes('Hold to lock'))!)).asElement()!.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down(); await sleep(1300); await page.mouse.up();
  await see(page, 'November 2026 is locked', 30000);
  await see(page, 'Payslips are released to 22 people');
  check(true, 'November is locked for Office 1');
  await snap(page, 'flow2-locked');

  const data = await apiGet<{ locked: boolean; lockedByName: string; totals: { people: number; unpaidDays: number; net: number; salary: number }; rows: { name: string; unpaidDays: number; net: number; salary: number }[] }>(page, `/api/payroll/${await officeId(page)}/2026-11`);
  const row = (name: string) => data.rows.find(r => r.name === name)!;
  check(data.locked && data.lockedByName === 'Vikram Singh' && data.totals.people === 22, 'the server has 22 payroll items, locked by Vikram Singh');
  check(row('Suresh Yadav').unpaidDays === 1 && row('Suresh Yadav').net === Math.round(28000 - 28000 / 30), 'Suresh Yadav: 1 absent day, net 27,067');
  check(row('Priya Nair').unpaidDays === 0.5 && row('Priya Nair').net === Math.round(52000 - (52000 / 30) * 0.5), 'Priya Nair: 1 late half day, net 51,133');
  check(row('Karan Malhotra').unpaidDays === 0 && row('Karan Malhotra').net === 36000, 'Karan Malhotra: the corrected day counts, full salary');
  check(data.totals.unpaidDays === 1.5, `Office 1 totals: ${data.totals.unpaidDays} unpaid days, net ${data.totals.net} of ${data.totals.salary}`);

  // After the lock nothing in November can change.
  const refused = await page.evaluate(async (id: string) => (await fetch(`/api/attendance/days/${id}/2026-11-05/manual`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inTime: '09:00', outTime: '18:00', reason: 'after the lock' }) })).status, await employeeId(page, 'Suresh Yadav'));
  check(refused === 409, 'a correction in the locked month is refused (409)');

  await click(page, 'Lock summary');
  await see(page, 'Attendance corrections · 2');
  await snap(page, 'flow2-lock-summary');
  await page.goto(`${BASE}/payroll/payslips`, { waitUntil: 'networkidle0' });
  await see(page, 'Suresh Yadav');
  await click(page, 'Suresh Yadav', 'a');
  await see(page, 'Net pay');
  await see(page, '27,067');
  await snap(page, 'flow2-payslip');
  const pdf = await page.evaluate(async () => { const a = [...document.querySelectorAll('a')].find(x => x.innerText.includes('Download PDF'))!; const r = await fetch(a.href); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), head: String.fromCharCode(...b.slice(0, 5)), size: b.length }; });
  check(pdf.status === 200 && pdf.type === 'application/pdf' && pdf.head === '%PDF-', `the payslip PDF downloads (${pdf.size} bytes)`);
  await signOut(page);

  await signIn(page, 'suresh.yadav@sbm.example');
  await page.goto(`${BASE}/me/payslips`, { waitUntil: 'networkidle0' });
  await see(page, 'November 2026');
  await see(page, '27,067');
  check(true, 'Suresh sees his November payslip');
  await signOut(page);
}
const officeId = async (page: Page) => (await apiGet<{ id: string }[]>(page, '/api/offices'))[0].id;
const employeeId = async (page: Page, name: string) => (await apiGet<{ items: { id: string; name: string }[] }>(page, `/api/employees?search=${encodeURIComponent(name)}`)).items[0].id;

async function flow3(page: Page) {
  log('\n3. The office head adds an employee, who sets a password and signs in');
  await signIn(page, 'vikram.singh@sbm.example');
  await page.goto(`${BASE}/people`, { waitUntil: 'networkidle0' });
  await see(page, '22 people');
  await click(page, 'Add employee');
  await see(page, 'They get an email to set their own password.');
  await fill(page, 'Full name', 'Asha Rao'); await fill(page, 'Work email', NEW_EMAIL); await fill(page, 'Designation', 'Accounts Executive'); await fill(page, 'Monthly salary', '32000');
  await snap(page, 'flow3-add-employee');
  await click(page, 'Add and send invite');
  await see(page, 'Asha Rao is added as EMP-01');
  await see(page, '23 people');
  check(true, 'Asha Rao was added to Office 1 and the invite was sent');
  await snap(page, 'flow3-added');
  const invited = await apiGet<{ items: { status: string; officeName: string; code: string }[] }>(page, '/api/employees?search=Asha');
  check(invited.items[0].status === 'invited' && invited.items[0].officeName === 'Office 1', `she is ${invited.items[0].code}, status invited, in the head's own office`);
  const link = await page.evaluate(() => [...document.querySelectorAll('a')].find(a => a.innerText.includes('open the invite link'))!.getAttribute('href')!);
  await signOut(page);

  // She cannot sign in before setting a password.
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await fill(page, 'Email', NEW_EMAIL); await fill(page, 'Password', NEW_PASSWORD);
  await click(page, 'Sign in', 'button[type=submit]');
  await see(page, 'Set your password from the invite email first.');
  check(true, 'signing in before the invite is used is refused');

  await page.goto(BASE + link, { waitUntil: 'networkidle0' });
  await see(page, 'Welcome, Asha');
  await see(page, 'You have been added to Office 1');
  await fill(page, 'New password', NEW_PASSWORD); await fill(page, 'Type it again', NEW_PASSWORD);
  await snap(page, 'flow3-set-password');
  await click(page, 'Set password and continue');
  await see(page, 'Welcome to Office 1');
  check(new URL(page.url()).pathname === '/me', 'she set a password and landed on her own home screen');
  await snap(page, 'flow3-first-day-home');
  await signOut(page);

  await signIn(page, NEW_EMAIL, NEW_PASSWORD);
  await see(page, 'Good morning, Asha');
  check(true, 'she signs in again with her new password');
  await page.goto(BASE + link, { waitUntil: 'networkidle0' });
  await see(page, 'This invite link has been used or has expired');
  check(true, 'the invite link works only once');
  await page.goto(`${BASE}/people`, { waitUntil: 'networkidle0' });
  await see(page, 'Good morning, Asha');
  check(new URL(page.url()).pathname === '/me', 'as an employee she is sent away from the manager screens');
  await signOut(page);
}

/** Opens every screen for each role. A screen fails if it shows the error box or never finishes loading. */
async function tour(page: Page) {
  log('\n4. Every screen loads with real data, for each role');
  const visit = async (who: string, paths: string[]) => {
    for (const p of paths) {
      // Home keeps its live event stream open, so wait for at most that one connection.
      await page.goto(BASE + p, { waitUntil: 'networkidle2' });
      await sleep(600);
      const state = await page.evaluate(() => ({ text: document.body.innerText, skeletons: document.querySelectorAll('.skeleton').length, path: location.pathname }));
      if (state.text.includes('This did not load') || state.text.includes('This page does not exist')) throw new Error(`${who}: ${p} did not load:\n${state.text.slice(0, 400)}`);
      if (state.skeletons > 0) throw new Error(`${who}: ${p} is still showing its loading skeleton`);
      if (state.path !== p.split('?')[0]) throw new Error(`${who}: ${p} redirected to ${state.path}`);
      await snap(page, `tour-${who}-${p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}`);
    }
    step(`ok  ${who}: ${paths.length} screens`);
  };
  await signIn(page, process.env.SEED_ADMIN_EMAIL!, process.env.SEED_ADMIN_PASSWORD!);
  const priya = await employeeId(page, 'Priya Nair');
  await visit('admin', ['/', '/people', '/people/offices', `/people/${priya}`, '/attendance?month=2026-11', '/attendance/corrections', '/attendance/terminals', '/leave', '/leave/calendar', '/leave/holidays', '/payroll', '/payroll/payslips', `/payroll/payslips/${priya}/2026-11`, '/settings', '/settings/audit']);
  // A few things that only appear after a click.
  await page.goto(`${BASE}/people/${priya}`, { waitUntil: 'networkidle0' });
  await click(page, 'Adjust or see entries'); await see(page, 'Monthly credit'); await see(page, 'Leave taken');
  await snap(page, 'tour-admin-leave-ledger');
  await page.goto(`${BASE}/attendance?month=2026-11`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { document.querySelector<HTMLElement>('button[aria-label*="Wed 4 Nov"][aria-label*="Priya Nair"]')!.click(); });
  await see(page, 'Raw punches from the terminal'); await see(page, 'Half day (late)');
  await snap(page, 'tour-admin-day-drawer');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await page.keyboard.type('4 nov'); await see(page, 'Wed 4 Nov 2026');
  await page.keyboard.press('Escape');
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await page.keyboard.type('suresh'); await see(page, 'Suresh Yadav · November 2026'); // the person, and his payslip
  await snap(page, 'tour-admin-search');
  await page.keyboard.press('Escape');
  check(true, 'the leave ledger, the day drawer with raw punches, and Ctrl+K search work');
  await signOut(page);

  await signIn(page, 'vikram.singh@sbm.example');
  await visit('head', ['/', '/people', '/attendance', '/attendance/terminals', '/leave', '/leave/holidays', '/payroll', '/settings/audit', '/me', '/me/attendance', '/me/leave', '/me/payslips']);
  await page.goto(`${BASE}/people/offices`, { waitUntil: 'networkidle2' }); // lands on Home, which keeps its stream open
  check(new URL(page.url()).pathname === '/', 'a head is kept out of the admin-only Offices screen');
  await signOut(page);

  await signIn(page, 'priya.nair@sbm.example');
  await visit('employee', ['/me', '/me/attendance', '/me/leave', '/me/leave/apply', '/me/payslips', '/me/payslips/2026-11', '/me/profile', '/me/correction/2026-12-01']);
  await signOut(page);
}

// ---------- run ----------
async function main() {
  if (!existsSync('dist/index.html')) throw new Error('Build the app first: npm run build');
  rmSync(SHOTS, { recursive: true, force: true }); mkdirSync(SHOTS, { recursive: true });
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync) ?? process.env.CHROME_PATH;
  if (!chrome) throw new Error('No Chrome or Edge found. Set CHROME_PATH.');

  let pg: Awaited<ReturnType<typeof startPostgres>> | null = null;
  let server: ChildProcess | null = null;
  let serverLog = '';
  try {
    log('Preparing');
    if (!(await portOpen(DEV_DB.port))) { pg = await startPostgres(dataDir(), DEV_DB.port, DEV_DB.database, true); step('started the local Postgres'); }
    const admin = new PrismaClient({ datasourceUrl: devDbUrl('postgres') });
    await admin.$executeRawUnsafe(`drop database if exists ${DB} with (force)`); await admin.$executeRawUnsafe(`create database ${DB}`); await admin.$disconnect();
    execSync('npx prisma migrate deploy --schema server/prisma/schema.prisma', { env, stdio: 'pipe' });
    execSync('npx tsx server/scripts/seed.ts --demo', { env, stdio: 'pipe' });
    step('fresh database with 3 offices and 42 people');

    server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', d => { serverLog += d; }); server.stderr!.on('data', d => { serverLog += d; });
    for (let i = 0; i < 60 && !(await portOpen(PORT)); i++) await sleep(500);
    if (!(await portOpen(PORT))) throw new Error(`The server did not start:\n${serverLog}`);
    step('server running as Tue 1 Dec 2026, 10:00 AM');
    await sleep(4000); // the first leave credit runs at start

    const prisma = new PrismaClient({ datasourceUrl: devDbUrl(DB) });
    const sent = await sendNovember(prisma);
    step(`${sent.punches} November punches for ${sent.people} people sent through the terminal listener`);
    await prisma.$disconnect();

    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: 1280, height: 900 }, args: ['--no-first-run', '--disable-extensions'] });
    const page = await browser.newPage();
    // tsx wraps named functions with a helper that only exists in Node. Give the page a no-op version.
    await page.evaluateOnNewDocument('window.__name = f => f');
    const problems: string[] = [];
    page.on('pageerror', e => problems.push(`page error: ${(e as Error).message}`));
    page.on('console', m => { if (m.type() === 'error' && !/401|403|404|409|410|422/.test(m.text())) problems.push(`console: ${m.text()}`); });
    try {
      await flow1(page); await flow2(page); await flow3(page); await tour(page);
    } catch (e) {
      await page.screenshot({ path: path.join(SHOTS, 'failure.png') as `${string}.png` }).catch(() => {});
      throw e;
    } finally { await browser.close(); }
    if (problems.length) throw new Error(`The browser reported problems:\n${problems.join('\n')}`);
    if (/\[error\]/.test(serverLog)) throw new Error(`The server logged an error:\n${serverLog.split('\n').filter(l => l.includes('[error]')).join('\n')}`);
    log(`\nAll three flows and the screen tour passed. Screenshots: ${SHOTS}`);
  } finally {
    server?.kill();
    await sleep(500);
    await pg?.stop();
  }
}

main().then(() => process.exit(0), e => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1); });
