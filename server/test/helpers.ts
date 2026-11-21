// Shared test fixtures: a clean database, two offices with a head and staff, and signed-in agents.
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { hashPassword } from '../src/lib/password';
import { dbDate, setNow } from '../src/lib/time';

export const PASSWORD = 'correct-horse-9';
export const app = createApp({ authRateLimit: 1000, staticDir: 'no-such-folder' });
export type Agent = ReturnType<typeof request.agent>;

/** Empties every table. */
export async function resetDb() {
  setNow(null);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`truncate table ${tables.map(t => `"${t.tablename}"`).join(', ')} restart identity cascade`);
}

let hash: string | null = null;
const pw = async () => (hash ??= await hashPassword(PASSWORD));

export async function makeAdmin(email = 'admin@test.example') {
  return prisma.user.create({ data: { email, name: 'Admin', role: 'admin', passwordHash: await pw() } });
}
export async function makeOffice(name: string) {
  return prisma.office.create({ data: { name, address: `${name} address` } });
}
let n = 0;
export async function makeEmployee(officeId: string, name: string, opts: { head?: boolean; salary?: number; status?: 'invited' | 'active' | 'inactive'; joinDate?: string } = {}) {
  n++;
  const office = await prisma.office.findUniqueOrThrow({ where: { id: officeId } });
  const e = await prisma.employee.create({
    data: {
      code: `T${office.number}-${n}`, name, officeId, designation: 'Executive',
      joiningDate: dbDate(opts.joinDate ?? '2024-01-01'), status: opts.status ?? 'active', terminalUserId: String(9000 + n),
      user: { create: { email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.example`, role: opts.head ? 'office_head' : 'employee', passwordHash: opts.status === 'invited' ? null : await pw() } },
      salaryHistory: { create: { monthlyAmount: opts.salary ?? 30000, effectiveMonth: '2024-01' } },
      leaveQuotas: { create: { year: new Date().getUTCFullYear(), clPerYear: 12, plPerYear: 18 } },
    },
    include: { user: true },
  });
  if (opts.head) await prisma.office.update({ where: { id: officeId }, data: { headEmployeeId: e.id } });
  return { ...e, email: e.user!.email, userId: e.user!.id };
}

/** A browser-like client that keeps its session cookie. */
export async function signIn(email: string, password = PASSWORD): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`sign in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
export const anon = () => request(app);

/** Admin, two offices, a head and two employees in each. */
export async function world() {
  const admin = await makeAdmin();
  const o1 = await makeOffice('Office 1');
  const o2 = await makeOffice('Office 2');
  const head1 = await makeEmployee(o1.id, 'Vikram Singh', { head: true, salary: 85000 });
  const priya = await makeEmployee(o1.id, 'Priya Nair', { salary: 52000 });
  const aarav = await makeEmployee(o1.id, 'Aarav Mehta', { salary: 48000 });
  const head2 = await makeEmployee(o2.id, 'Rahul Khanna', { head: true, salary: 78000 });
  const sunita = await makeEmployee(o2.id, 'Sunita Agarwal', { salary: 41000 });
  return { admin, o1, o2, head1, priya, aarav, head2, sunita };
}

/** The invite or reset link token from the newest email to this address. */
export async function tokenFromEmail(to: string, kind: 'invite' | 'reset'): Promise<string> {
  const m = await prisma.emailOutbox.findFirst({ where: { toEmail: to, body: { contains: `/${kind}/` } }, orderBy: { createdAt: 'desc' } });
  const found = m?.body.match(new RegExp(`/${kind}/([A-Za-z0-9_-]+)`));
  if (!found) throw new Error(`no ${kind} email for ${to}`);
  return found[1];
}
