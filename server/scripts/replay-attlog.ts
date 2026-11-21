// Plays the part of a terminal, so punches can be tested without one.
// It does what the device does: handshake, then POST ATTLOG lines to /iclock/cdata.
//
//   npm run replay                                   sample file, serial DEMO0001, times moved to today
//   npm run replay -- --sn DEMO0002 --file my.txt    your own captured lines, sent as they are
//   npm run replay -- --punch 117                    one punch now for terminal user 117
//   npm run replay -- --punch 117 --at 18:05         one punch today at 18:05
//   npm run replay -- --host my-proxy.rlwy.net:12345 against a deployed server
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(`--${name}`);

const host = opt('host') ?? `localhost:${process.env.ADMS_PORT ?? 8081}`;
const sn = opt('sn') ?? 'DEMO0001';
const base = `http://${host}/iclock`;

// The office clock (Asia/Kolkata), whatever the time zone of this computer.
const ist = new Date(Date.now() + 330 * 60000).toISOString();
const todayIst = ist.slice(0, 10);
const nowIst = ist.slice(11, 19);

function lines(): string[] {
  const punch = opt('punch');
  if (punch) {
    const at = opt('at');
    const time = at ? (at.length === 5 ? `${at}:00` : at) : nowIst;
    return [`${punch}\t${opt('date') ?? todayIst} ${time}\t0\t1\t0\t0\t0`];
  }
  const file = opt('file') ?? path.join(import.meta.dirname, 'sample-attlog.txt');
  const raw = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  // The sample file is dated 2026-01-01. Unless --keep-dates is given, its punches are moved to today.
  return opt('file') && !has('today') || has('keep-dates') ? raw : raw.map(l => l.replace(/\d{4}-\d{2}-\d{2}/, todayIst));
}

async function main() {
  console.log(`Terminal ${sn} -> ${base}`);
  const hello = await fetch(`${base}/cdata?SN=${encodeURIComponent(sn)}&options=all&pushver=2.4.1&language=69`);
  const text = await hello.text();
  console.log(`\nGET /iclock/cdata  ${hello.status}\n${text.trim().split('\n').map(l => `  ${l}`).join('\n')}`);
  const stamp = Number(/ATTLOGStamp=(\d+)/.exec(text)?.[1] ?? 0);

  const body = lines();
  const post = await fetch(`${base}/cdata?SN=${encodeURIComponent(sn)}&table=ATTLOG&Stamp=${stamp + body.length}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `${body.join('\n')}\n` });
  console.log(`\nPOST /iclock/cdata table=ATTLOG (${body.length} ${body.length === 1 ? 'line' : 'lines'})  ${post.status}  ${(await post.text()).trim()}`);
  body.slice(0, 8).forEach(l => console.log(`  ${l.replace(/\t/g, '  ')}`));
  if (body.length > 8) console.log(`  ... and ${body.length - 8} more`);

  const beat = await fetch(`${base}/getrequest?SN=${encodeURIComponent(sn)}`);
  console.log(`\nGET /iclock/getrequest  ${beat.status}  ${(await beat.text()).trim()}`);
  if (text.includes('ATTLOGStamp=0') && stamp === 0) console.log('\nNote: if nothing shows up in the app, this serial may not be registered. Unknown serials get "OK" and are listed under unregistered terminals.');
}

main().catch(e => { console.error(`Could not reach ${base}: ${e instanceof Error ? e.message : e}\nIs the server running (npm run dev:server)?`); process.exit(1); });
