// Seed. Always: the admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD and the default settings.
// With --demo (never in production): three offices, their heads and 42 employees, all with the password "demo1234".
// Safe to run again: it only adds what is missing.
import { prisma } from '../src/db';
import { env, isProd } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { dbDate, today } from '../src/lib/time';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/services/settings';

export const DEMO_PASSWORD = 'demo1234';

type Row = [code: string, name: string, designation: string, salary: number, joinDate: string, head?: true];
const OFFICES: { name: string; address: string; staff: Row[] }[] = [
  {
    name: 'Office 1', address: 'Connaught Place, New Delhi', staff: [
      ['EMP-0102', 'Vikram Singh', 'Office Head', 85000, '2018-06-04', true],
      ['EMP-0103', 'Aarav Mehta', 'Senior Accountant', 48000, '2019-02-11'],
      ['EMP-0104', 'Neha Kapoor', 'Accounts Executive', 45000, '2019-08-19'],
      ['EMP-0105', 'Rohit Bansal', 'Sales Executive', 42000, '2020-01-06'],
      ['EMP-0106', 'Sneha Iyer', 'Operations Executive', 38000, '2020-09-14'],
      ['EMP-0108', 'Karan Malhotra', 'Sales Executive', 36000, '2021-03-01'],
      ['EMP-0109', 'Pooja Reddy', 'Customer Support', 34000, '2021-07-12'],
      ['EMP-0110', 'Amit Joshi', 'Purchase Executive', 40000, '2020-11-02'],
      ['EMP-0111', 'Divya Menon', 'HR Executive', 37000, '2021-10-18'],
      ['EMP-0112', 'Suresh Yadav', 'Office Assistant', 28000, '2022-01-10'],
      ['EMP-0113', 'Meera Pillai', 'Customer Support', 33000, '2022-04-04'],
      ['EMP-0114', 'Arjun Desai', 'Sales Manager', 44000, '2019-11-25'],
      ['EMP-0115', 'Kavita Rao', 'Front Desk', 31000, '2022-08-22'],
      ['EMP-0116', 'Manish Gupta', 'Accounts Executive', 39000, '2021-01-18'],
      ['EMP-0117', 'Priya Nair', 'Operations Executive', 52000, '2020-04-13'],
      ['EMP-0118', 'Deepak Chauhan', 'Dispatch Assistant', 26000, '2023-02-06'],
      ['EMP-0119', 'Ritu Saxena', 'Data Entry Operator', 30000, '2023-05-15'],
      ['EMP-0120', 'Nikhil Jain', 'Sales Executive', 35000, '2022-11-07'],
      ['EMP-0122', 'Anjali Thomas', 'Customer Support', 32000, '2023-09-04'],
      ['EMP-0124', 'Varun Khanna', 'Dispatch Assistant', 29000, '2024-01-08'],
      ['EMP-0126', 'Shreya Ghosh', 'Data Entry Operator', 27000, '2024-06-17'],
      ['EMP-0128', 'Tarun Bhatia', 'Purchase Executive', 41000, '2021-05-24'],
    ],
  },
  {
    name: 'Office 2', address: 'Sector 18, Noida', staff: [
      ['EMP-0201', 'Rahul Khanna', 'Office Head', 78000, '2019-04-01', true],
      ['EMP-0202', 'Sunita Agarwal', 'Senior Accountant', 41000, '2019-09-09'],
      ['EMP-0203', 'Imran Sheikh', 'Sales Executive', 36000, '2020-06-15'],
      ['EMP-0204', 'Lakshmi Narayan', 'Customer Support', 33000, '2021-02-08'],
      ['EMP-0205', 'Gaurav Tiwari', 'Purchase Executive', 38000, '2020-10-05'],
      ['EMP-0206', 'Nisha Verghese', 'HR Executive', 35000, '2021-08-16'],
      ['EMP-0207', 'Harish Patel', 'Dispatch Assistant', 29000, '2022-03-21'],
      ['EMP-0208', 'Tanvi Kulkarni', 'Operations Executive', 32000, '2022-07-11'],
      ['EMP-0209', 'Mohit Arora', 'Sales Manager', 44000, '2019-12-02'],
      ['EMP-0210', 'Rekha Bose', 'Front Desk', 27000, '2023-01-16'],
      ['EMP-0211', 'Sanjay Mishra', 'Office Assistant', 30000, '2023-06-05'],
      ['EMP-0212', 'Aditi Sen', 'Accounts Executive', 34000, '2022-10-10'],
    ],
  },
  {
    name: 'Office 3', address: 'Cyber City, Gurugram', staff: [
      ['EMP-0301', 'Farhan Qureshi', 'Office Head', 72000, '2020-02-03', true],
      ['EMP-0302', 'Geeta Rawat', 'Front Desk', 31000, '2021-04-19'],
      ['EMP-0303', 'Yash Dubey', 'Sales Executive', 36000, '2021-09-06'],
      ['EMP-0304', 'Zoya Ansari', 'Accounts Executive', 39000, '2020-08-24'],
      ['EMP-0305', 'Prakash Nambiar', 'Office Assistant', 28000, '2022-05-09'],
      ['EMP-0306', 'Simran Gill', 'Customer Support', 33000, '2022-12-12'],
      ['EMP-0307', 'Vivek Rathore', 'Sales Manager', 42000, '2020-05-18'],
      ['EMP-0308', 'Bhavna Shetty', 'Operations Executive', 30000, '2023-08-07'],
    ],
  },
];
const emailOf = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}@sbm.example`;

async function seedAdmin() {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
    console.log('[seed] SEED_ADMIN_EMAIL or SEED_ADMIN_PASSWORD is not set: no admin was created.');
    return;
  }
  if (env.SEED_ADMIN_PASSWORD.length < 8) throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters.');
  const email = env.SEED_ADMIN_EMAIL.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) { console.log(`[seed] Admin ${email} already exists. Its password was left as it is.`); return; }
  await prisma.user.create({ data: { email, name: 'Admin', role: 'admin', passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD) } });
  console.log(`[seed] Admin ${email} created.`);
}

async function seedSettings() {
  const current = await prisma.setting.findMany({ select: { key: true } });
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => !current.some(c => c.key === k)));
  await saveSettings(prisma, missing);
}

async function seedDemo() {
  if (isProd) throw new Error('Demo data is for development only. It is refused when NODE_ENV=production.');
  if (await prisma.office.count()) { console.log('[seed] Offices already exist: demo data was not added again.'); return; }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const settings = await getSettings(prisma);
  const year = Number(today().slice(0, 4));
  for (const o of OFFICES) {
    const office = await prisma.office.create({ data: { name: o.name, address: o.address } });
    let maxSeq = 0;
    for (const [code, name, designation, salary, joinDate, head] of o.staff) {
      const seq = Number(code.slice(-2)); maxSeq = Math.max(maxSeq, seq);
      const e = await prisma.employee.create({
        data: {
          code, name, designation, officeId: office.id, joiningDate: dbDate(joinDate), status: 'active',
          phone: `98${String(10000000 + office.number * 100000 + seq * 137).slice(0, 8)}`,
          terminalUserId: String(office.number * 100 + seq),
          user: { create: { email: emailOf(name), role: head ? 'office_head' : 'employee', passwordHash } },
          salaryHistory: { create: { monthlyAmount: salary, effectiveMonth: joinDate.slice(0, 7) } },
          leaveQuotas: { create: { year, clPerYear: settings.defaultClQuota, plPerYear: settings.defaultPlQuota } },
        },
      });
      if (head) await prisma.office.update({ where: { id: office.id }, data: { headEmployeeId: e.id } });
    }
    await prisma.office.update({ where: { id: office.id }, data: { nextEmployeeSeq: maxSeq + 1 } });
  }
  console.log(`[seed] Demo data added: 3 offices, 42 people. Everyone signs in as firstname.lastname@sbm.example with "${DEMO_PASSWORD}".`);
}

/** One terminal per office, so the replay script has something to talk to. */
async function seedDemoDevices() {
  if (isProd || (await prisma.device.count())) return;
  for (const o of await prisma.office.findMany({ orderBy: { number: 'asc' } })) {
    await prisma.device.create({ data: { officeId: o.id, name: `${o.name} door`, serialNumber: `DEMO${String(o.number).padStart(4, '0')}` } });
  }
  console.log('[seed] Demo terminals added: serials DEMO0001, DEMO0002, DEMO0003.');
}

async function main() {
  await seedSettings();
  await seedAdmin();
  if (process.argv.includes('--demo')) { await seedDemo(); await seedDemoDevices(); }
}

main().then(() => prisma.$disconnect()).catch(async e => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });
