# SBM Management HR

Attendance, leave and monthly salary for one company with three offices.

Attendance is never typed in. Employees punch on an eSSL biometric terminal at each office door, the
terminal pushes the punches to this server (ADMS protocol), and the app shows what the terminal recorded.

- **App:** React + Vite + TypeScript + Tailwind, in `src/`
- **Server:** Node + Express + TypeScript + Prisma, in `server/`
- **Database:** PostgreSQL (Supabase in production)
- **Hosting:** one Railway service that runs the API, serves the built app, and listens for the terminals

Currency is INR. Business time is Asia/Kolkata. Timestamps are stored in UTC.

## Contents

1. [Run it on your computer](#1-run-it-on-your-computer)
2. [Commands](#2-commands)
3. [Testing without a terminal](#3-testing-without-a-terminal)
4. [Deploy: Supabase and Railway](#4-deploy-supabase-and-railway)
5. [The terminal: TCP proxy and Cloud Server settings](#5-the-terminal-tcp-proxy-and-cloud-server-settings)
6. [Environment variables](#6-environment-variables)
7. [Going live: first steps in the app](#7-going-live-first-steps-in-the-app)
8. [How it works](#8-how-it-works)
9. [Folder map](#9-folder-map)
10. [Good to know](#10-good-to-know)

---

## 1. Run it on your computer

You need Node 20.19 or newer (22 or 24 is fine). You do **not** need to install Postgres: the project
brings its own for development.

```bash
npm install
```

Then three terminals, in this order:

```bash
# Terminal 1: the database. Leave it open.
npm run db:start
```

The first run creates a `.env` file with working local settings, including a generated admin password.
The database files are kept in `%LOCALAPPDATA%\sbm-hr\pgdata` (outside the project, so OneDrive does not lock them).

```bash
# Terminal 2: tables, sample data, then the server
npm run db:deploy
npm run seed:demo
npm run dev:server
```

```bash
# Terminal 3: the app
npm run dev
```

Open http://localhost:5173.

| Sign in as | Email | Password |
| --- | --- | --- |
| Admin | `admin@sbm.example` | `SEED_ADMIN_PASSWORD` in `.env` |
| Office head, Office 1 | `vikram.singh@sbm.example` | `demo1234` |
| Office head, Office 2 | `rahul.khanna@sbm.example` | `demo1234` |
| Office head, Office 3 | `farhan.qureshi@sbm.example` | `demo1234` |
| Employee, Office 1 | `priya.nair@sbm.example` | `demo1234` |

Every demo employee signs in as `firstname.lastname@sbm.example`. The demo data has people and
terminals but no punches yet: send some with `npm run replay` (section 3).

**Emails in development.** With no SMTP set, invite and reset emails are printed in the server
window (terminal 2) within a minute, so you can copy the link. After adding an employee, the green
banner also shows a "Development only" link to the invite.

## 2. Commands

| Command | What it does |
| --- | --- |
| `npm run db:start` | Local Postgres on port 54329. Leave it running. |
| `npm run db:deploy` | Apply the migrations to the database in `.env`. |
| `npm run db:migrate` | After changing `server/prisma/schema.prisma`: create and apply a new migration. |
| `npm run seed` | Create the admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` and the default settings. Safe to run again. |
| `npm run seed:demo` | The same, plus 3 offices, 42 people and 3 terminals. Refused in production. |
| `npm run dev:server` | The server, restarting on change. API on `PORT` (3000), terminals on `ADMS_PORT` (8081). |
| `npm run dev` | The app on http://localhost:5173, with `/api` passed on to the server. |
| `npm run replay` | Play the part of a terminal (section 3). |
| `npm run test:server` | 184 server tests against a throwaway Postgres it starts itself. |
| `npm test` | Tests of the app's API client. |
| `npm run e2e` | Real browser, real server: the three main flows and every screen. Run `npm run build` first. |
| `npm run build` | Type-check everything, build the app into `dist/` and the server into `server/dist/`. |
| `npm start` | What production runs: apply migrations, seed the admin, start the server. |

## 3. Testing without a terminal

`npm run replay` does exactly what the device does: the handshake, then an upload of punches.

```bash
npm run replay                                    # 12 sample punches, dated today, from terminal DEMO0001
npm run replay -- --punch 117                     # one punch now for terminal user 117 (Priya Nair)
npm run replay -- --punch 117 --at 18:05          # one punch today at 18:05
npm run replay -- --punch 117 --date 2026-11-20 --at 08:57
npm run replay -- --sn DEMO0002 --file my-log.txt # lines captured from a real terminal, sent as they are
npm run replay -- --sn NEWSERIAL --punch 117      # an unknown serial: nothing is stored, it shows up as unregistered
npm run replay -- --host my-proxy.proxy.rlwy.net:12345 --sn DEMO0001   # against a deployed server
```

Watch the Home screen while you run it: the board updates by itself.

To try a month end without waiting for one, start the server at another date (development only):

```bash
SBM_FAKE_NOW=2026-12-01T10:00:00+05:30 npm run dev:server      # PowerShell: $env:SBM_FAKE_NOW='2026-12-01T10:00:00+05:30'; npm run dev:server
```

## 4. Deploy: Supabase and Railway

These steps have been checked on this computer by running the production build (`npm run build`,
`npm start`) against a local Postgres. They have **not** been run against a real Supabase project or
Railway service from here, so follow them once with care and tell me what differs.

### 4.1 Supabase (the database)

1. Create a project. Pick a region close to India (Mumbai) and keep the database password.
2. Open **Connect** and copy the **Session pooler** connection string. It looks like
   `postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`.
3. Use that same string for both `DATABASE_URL` and `DIRECT_URL`, adding `?connection_limit=5` to `DATABASE_URL`.

Why the session pooler: this is one long-running server with a handful of connections, which is what
session mode is for, and it works over IPv4 (Railway cannot reach Supabase's direct IPv6 address).
If you later prefer the transaction pooler (port 6543) for `DATABASE_URL`, add `?pgbouncer=true&connection_limit=5`
and keep the session pooler for `DIRECT_URL`, which the migrations use.

You do not create tables by hand. The first deploy runs the migrations.

### 4.2 Railway (the server)

1. Put this folder (`sbm-hr-app`) in a GitHub repository and create a Railway project from it.
   `railway.json` already tells Railway what to do:
   - build: `npm run build` (the app into `dist/`, the server into `server/dist/`)
   - start: `npm start` (apply migrations, create the admin if missing, start)
   - health check: `/api/health`
2. In the service's **Variables**, set everything in section 6. The ones people forget:
   - `NODE_ENV=production`
   - `APP_URL` = the public https address (step 3), with no slash at the end
   - `SESSION_SECRET` = a long random string, for example from `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   - **Do not set `PORT`.** Railway provides it.
3. **Settings, Networking, Generate Domain.** This gives the https address of the app. Put it in `APP_URL` and redeploy.
4. Open the address and sign in with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.
   Then remove `SEED_ADMIN_PASSWORD` from the variables: it is only used to create the admin the first time.

One service runs everything: the API and the app on `PORT` behind Railway's HTTPS domain, and the
terminal listener on `ADMS_PORT`. Run **one** instance only (the live board and the scheduled jobs live in that process).

## 5. The terminal: TCP proxy and Cloud Server settings

The terminal speaks plain HTTP, not HTTPS, so it cannot use the app's https address. Railway's
**TCP Proxy** gives it a plain address that leads to `ADMS_PORT`. Only `/iclock/...` exists on that
port: the API cannot be reached through it.

### 5.1 Add the TCP proxy

1. In Railway, open the service, then **Settings, Networking, TCP Proxy**.
2. Enter the internal port: `8081` (the value of `ADMS_PORT`).
3. Railway shows a host and a port, for example `shuttle.proxy.rlwy.net` and `15140`. Note both.

Check it from any computer before going to the terminal:

```bash
curl "http://shuttle.proxy.rlwy.net:15140/iclock/cdata?SN=TEST&options=all"
```

You should see a block of text starting with `GET OPTION FROM: TEST`.

### 5.2 On the terminal

Menu, **Comm.**, **Cloud Server Setting** (on some models: **ADMS**):

| Setting | Value |
| --- | --- |
| Server mode | **ADMS** |
| Enable Domain Name | **On** |
| Server address | the proxy host, for example `shuttle.proxy.rlwy.net` (no `http://`, no path) |
| Server port | the proxy port, for example `15140` |
| Enable Proxy Server | Off |
| HTTPS | Off |

Also check, under **System, Date Time**, that the terminal's clock shows the correct India time. The
server reads punch times as Asia/Kolkata exactly as the terminal sends them.

The terminal needs a DNS server to look up the proxy host: under **Comm., Ethernet** (or Wi-Fi),
use DHCP, or set DNS to your router or `8.8.8.8`.

### 5.3 Register it in the app

1. Within a minute of saving the settings, open **Attendance, Terminals** in the app. A banner says a
   terminal with its serial number is calling and is not registered.
2. Press **Register**, give it a name, choose the office. A head can only register for their own office.
3. Punch once. The punch appears under "Latest punches received" within a few seconds.

Until a terminal is registered, the server answers it politely and stores nothing from it.

### 5.4 Match people to the terminal

Each employee has a **Terminal user ID** on their profile (People, a person, Edit details). It must be
the same number as the user ID the person is enrolled under on the terminal. A punch from a number
that belongs to nobody is kept and listed on the Terminals screen under "Punches with no employee".
Enter that number on the right profile and those punches count for that person.

## 6. Environment variables

| Variable | Needed | What it is |
| --- | --- | --- |
| `NODE_ENV` | production | `production` on Railway. Turns on Secure cookies and turns off development helpers. |
| `DATABASE_URL` | yes | Postgres connection the server uses. |
| `DIRECT_URL` | yes | Postgres connection the migrations use. Locally the same as `DATABASE_URL`. |
| `SESSION_SECRET` | yes | At least 32 random characters. Changing it signs everyone out. |
| `PORT` | Railway sets it | Port of the API and the app. 3000 locally. |
| `ADMS_PORT` | optional | Port of the terminal listener. Default 8081. Must differ from `PORT`. |
| `APP_URL` | yes | Public address of the app, used in email links: `https://your-app.up.railway.app`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | for email | Your mail provider's SMTP details. Port 587 or 465. |
| `MAIL_FROM` | for email | For example `SBM HR <hr@yourcompany.com>`. Must be an address your SMTP account may send from. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | first deploy | The first admin. Created once, never overwritten. |

Without `SMTP_HOST` in production, emails wait in the `email_outbox` table and are sent once SMTP is
set. **Invites are emails**, so set SMTP before adding people.

## 7. Going live: first steps in the app

1. **Admin:** People, Offices and heads, **Add office** for each of the three offices. Check the start time and hours.
2. **Admin:** People, **Add employee** for each office head, ticking "Make this person the office head". They get an invite email.
3. **Each head:** add their employees (name, email, salary, joining date). Everyone gets an invite, valid 72 hours. "Send a new invite" on a profile makes a fresh link.
4. **Each head:** register the office terminal (section 5.3) and check every employee's Terminal user ID (section 5.4).
5. **Leave balances.** When the server first starts, it credits everyone 1/12 of their yearly quota for every month from January (or from the first full month after joining) to now. People will already have taken leave this year, so each head sets the real figure once: a profile, Leave balance, **Adjust or see entries**.
6. **Holidays:** Leave, Holidays, add the year's dates.

## 8. How it works

**Punches to attendance.** Every punch is stored exactly as received and never changed. For each
person and date, the first punch is the check-in and the last is the check-out; punches under two
minutes apart count as one. On a working day, in this order:

1. approved full-day leave: on leave (paid for CL and PL, unpaid for unpaid leave)
2. no punch: absent
3. one punch: missing punch (must be resolved before the month is locked)
4. under 4.5 hours: absent
5. in after 09:00:59: half day (late)
6. under 9 hours: half day (short hours)
7. otherwise present

Sundays and the 2nd and 4th Saturday are off. Office holidays are off. A calendar override wins over
both. An approved half-day CL or PL lifts a half day to full pay. The office start time and hours are
set per office.

**Leave.** A balance is only ever the sum of the leave ledger. 1/12 of the yearly quota is credited on
the 1st of each month. On 31 December CL goes to zero and PL carries over up to the cap (30).
A request counts working days only and cannot go past the balance.

**Approvals.** An employee's request goes to their office head, a head's own request to the admin.
After 2 working days without a decision it also goes to the admin. Nobody decides their own request.
The person who decided can undo it for 60 seconds. The admin can reverse a decision until the month is locked.

**Payroll.** Day rate = monthly salary ÷ calendar days in the month. Net = salary − day rate × unpaid
days, rounded to the nearest rupee. A month can be locked once it is over, with no missing punch and
no pending request. Locking freezes the month, stores every figure, releases the payslips and emails
the admin a summary. Only the admin can unlock.

**Who sees what.** The admin: everything. A head: their own office, and not their own salary, quota,
balance or requests. An employee: their own attendance, leave and payslips. The server enforces this
on every request.

**Scheduled jobs** (India time): emails every minute, escalation hourly 09:00 to 19:00, leave credit
and year end at 00:05, day finalize, silent-terminal check and badges at 23:55.

## 9. Folder map

```
src/                      the app
  api/index.ts            typed API client, one function per endpoint
  api/hooks.ts            TanStack Query hooks, optimistic approve / reject, the live board stream
  api/http.ts             fetch wrapper: errors, signed-out handling, server clock
  auth.tsx, App.tsx       session context and the route table with role guards
  layout.tsx, shared.tsx, ui.tsx   shells and the design system
  pages/                  Login, admin/ (Home, People, Attendance, Leave, Payroll), me/ (employee screens)
server/
  prisma/schema.prisma    the data model, with migrations/
  src/index.ts            starts both listeners and the jobs
  src/app.ts              the API app (and the built frontend in production)
  src/adms/app.ts         the terminal listener: /iclock only
  src/routes/             one file per area of the API
  src/services/           the rules: day-rules, attendance, calendar, leave, payroll-rules, payroll,
                          gamification, permissions
  src/middleware/auth.ts  session cookie, role guards, office scoping
  scripts/                dev-db (local Postgres), seed, replay-attlog
  test/                   184 tests
e2e/run.ts                the three flows and a tour of every screen, in a real browser
docs/backend-map.md       each screen and the endpoints it uses, with the decisions made along the way
railway.json              build, start and health check for Railway
```

## 10. Good to know

- **Back up the database.** `raw_punches` is the one table that cannot be rebuilt from anything else. Supabase's paid plans take daily backups; on the free plan, export it yourself on a schedule.
- **One instance only.** Do not scale the Railway service to several replicas: the live board and the jobs assume one process.
- **Terminal offline.** The terminal keeps punches while it cannot reach the server and sends them, with their original times, when it reconnects. The app shows a terminal as offline after 5 minutes of silence and alerts the head and the admin after 12 hours on a working day.
- **A wrong clock on the terminal** gives wrong times in the app. Raw punches are never edited, so the fix is a correction on the affected days and setting the terminal's clock.
- **Sign-in limits:** 10 attempts a minute per email address, 60 a minute per IP address.
- **Sessions** end after 12 hours without use, and after 7 days in any case.
- **Payslip amounts** are written as "Rs." in the PDF, because its built-in fonts have no rupee sign.
- **Not built:** moving an employee from one office to another. Ask if you need it.
- `docs/system-design.md` and `docs/openapi.yaml` describe an earlier plan and are kept only for history. The code, this file and `docs/backend-map.md` are current.
