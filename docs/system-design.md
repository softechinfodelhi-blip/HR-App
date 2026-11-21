# SBM Management HR: system design

This document is the build plan for the backend that sits behind the React app in this folder.
The app already runs every screen against a mock API (`src/api`). The backend has to serve the
same contract (`docs/openapi.yaml`) and produce the same numbers as `src/lib/rules.ts`.

Stack assumed: Node 22 + TypeScript, Postgres 16, REST over JSON, cookie sessions, hosted on Railway.

Contents

1. Architecture
2. Roles and permissions
3. Data model
4. Terminal ingestion (ADMS push)
5. Attendance rules
6. Leave rules
7. Requests, undo and escalation
8. Payroll and the month lock
9. Notifications and email
10. Audit log
11. Auth and security
12. API conventions
13. Payslip PDF
14. Scheduled jobs
15. Deployment
16. Connecting the app to the backend
17. Assumptions to confirm

---

## 1. Architecture

```
 eSSL / ZKTeco terminal (one per office)
        |  HTTP push, plain text (ADMS)            Browser (React app)
        v                                               |  HTTPS, JSON, session cookie
 +--------------------------- Node server ---------------------------+
 |  /iclock/*  ingest        /api/*  REST           jobs (cron)      |
 |      |                       |                      |             |
 |      +----> services: attendance, leave, payroll, requests <------+
 |                    |                 |                            |
 |               Postgres          email provider      PDF renderer  |
 +-------------------------------------------------------------------+
```

One Node process is enough for 50 people. Keep three layers:

- `routes/` parse and validate input (zod), check the session, call a service.
- `services/` hold all business rules. Port `src/lib/rules.ts` here unchanged and keep its tests.
- `db/` SQL only (Kysely, Drizzle or plain `pg`). No rules in SQL.

All times are stored as `timestamptz`. Every rule is evaluated in `Asia/Kolkata`. A "work date"
is the calendar date in that zone. The API sends dates as `YYYY-MM-DD`, clock times as `HH:mm`
and timestamps as local `YYYY-MM-DDTHH:mm`, which is what the app's formatters expect.

## 2. Roles and permissions

There are three roles. An office head is also an employee of that office.

| Action | Admin | Office head | Employee |
| --- | --- | --- | --- |
| See offices | all | own office | no |
| Edit office, choose its head | yes | no | no |
| See employees, attendance, leave | all | own office | self |
| Add or edit an employee | any office | own office, not self | no |
| See and set salary | all | own office, not own salary | sees own |
| Approve leave and corrections | any, and the only one for a head's request | own office, not own | no |
| Correct a day directly (manual entry) | yes | own office, not own | no |
| Holidays | all offices | own office | read |
| Review and lock a month | any office | own office | no |
| Unlock a month | yes | no | no |
| Audit log | all | own office | no |
| Settings | yes | no | no |
| Own attendance, leave, payslips | no (admin has none) | yes | yes |

Rules to enforce in one place (`can(user, action, target)`), never in the routes:

- A head's office scope comes from the session, never from a query parameter. If a head sends
  `office=o2`, answer 403.
- A head cannot change their own record: details, salary, quotas, attendance, requests.
- Salary amounts never appear in the audit log or in notifications.
- Every write checks the month lock (section 8).

The mock implements the same checks in `src/api/index.ts` (`scopeOf`, `canManage`, `canView`,
`assertOpen`), which you can read as executable examples.

## 3. Data model

```sql
create extension if not exists citext;

create table offices (
  id          text primary key,              -- 'o1'
  name        text not null,
  address     text not null default '',
  head_id     text                            -- references employees(id), set after insert
);

create table employees (
  id                text primary key,        -- 'EMP-0117', shown everywhere
  name              text not null,
  email             citext not null unique,
  phone             text not null default '',
  office_id         text references offices(id),   -- null for the admin
  role              text not null check (role in ('admin','head','employee')),
  designation       text not null default '',
  join_date         date not null,
  status            text not null check (status in ('invited','active','inactive')),
  terminal_user_id  text unique,             -- the PIN enrolled on the device, same on all terminals
  cl_quota          numeric(4,1) not null default 12,
  pl_quota          numeric(4,1) not null default 18,
  best_streak       int not null default 0,
  password_hash     text,
  created_at        timestamptz not null default now()
);
alter table offices add foreign key (head_id) references employees(id);

create table salary_revisions (
  id               bigserial primary key,
  employee_id      text not null references employees(id),
  amount           numeric(12,2) not null check (amount > 0),
  effective_month  date not null,            -- first day of the month
  set_by           text not null references employees(id),
  set_at           timestamptz not null default now(),
  unique (employee_id, effective_month)
);

create table terminals (
  id            text primary key,
  office_id     text not null references offices(id),
  name          text not null,
  serial        text not null unique,        -- SN sent by the device
  last_seen_at  timestamptz,
  att_stamp     text                          -- last ATTLOG stamp acknowledged
);

-- Raw punches. Insert only. Never updated, never deleted.
create table punches (
  id                bigserial primary key,
  terminal_id       text not null references terminals(id),
  terminal_user_id  text not null,
  employee_id       text references employees(id),   -- null while the PIN is unknown
  punched_at        timestamptz not null,            -- device time
  received_at       timestamptz not null default now(),
  raw               text not null,
  unique (terminal_id, terminal_user_id, punched_at)
);
create index on punches (employee_id, punched_at);

-- A correction sits on top of the raw punches for one day.
create table manual_days (
  employee_id  text not null references employees(id),
  work_date    date not null,
  in_time      time,
  out_time     time,
  reason       text not null,
  set_by       text not null references employees(id),
  set_at       timestamptz not null default now(),
  request_id   bigint,                        -- the correction request it came from, if any
  primary key (employee_id, work_date)
);

create table holidays (
  id    bigserial primary key,
  date  date not null,
  name  text not null,
  kind  text not null check (kind in ('holiday','working'))   -- 'working' = forced working day on a weekly off
);
create table holiday_offices (
  holiday_id  bigint not null references holidays(id) on delete cascade,
  office_id   text not null references offices(id),
  primary key (holiday_id, office_id)
);

create table leave_requests (
  id           bigserial primary key,
  employee_id  text not null references employees(id),
  type         text not null check (type in ('CL','PL','UNPAID')),
  from_date    date not null,
  to_date      date not null,
  half         boolean not null default false,
  days         numeric(4,1) not null,         -- working days charged, frozen when the request is made
  reason       text not null,
  status       text not null check (status in ('pending','approved','rejected','cancelled')),
  created_at   timestamptz not null default now(),
  decided_by   text references employees(id),
  decided_at   timestamptz,
  comment      text,
  check (to_date >= from_date),
  check (not half or from_date = to_date)
);

create table correction_requests (
  id           bigserial primary key,
  employee_id  text not null references employees(id),
  work_date    date not null,
  in_time      time,
  out_time     time,
  reason       text not null,
  status       text not null check (status in ('pending','approved','rejected','cancelled')),
  created_at   timestamptz not null default now(),
  decided_by   text references employees(id),
  decided_at   timestamptz,
  comment      text
);
create unique index one_pending_correction on correction_requests (employee_id, work_date) where status = 'pending';

-- Leave balance = sum of this ledger. Never store a balance column.
create table leave_ledger (
  id           bigserial primary key,
  employee_id  text not null references employees(id),
  type         text not null check (type in ('CL','PL')),
  entry_date   date not null,
  kind         text not null check (kind in ('opening','credit','leave','carry_over','lapse','adjustment')),
  days         numeric(5,2) not null,         -- positive adds, negative uses
  request_id   bigint references leave_requests(id),
  note         text
);
create unique index one_credit_per_month on leave_ledger (employee_id, type, entry_date) where kind = 'credit';

-- One row per employee per date. A cache of classifyDay(), rebuilt when an input changes.
create table attendance_days (
  employee_id      text not null references employees(id),
  work_date        date not null,
  status           text not null,             -- same values as DayStatus in src/types.ts
  in_time          time,
  out_time         time,
  worked_min       int not null default 0,
  unpaid           numeric(2,1) not null default 0,
  late             boolean not null default false,
  manual           boolean not null default false,
  other_office_id  text,
  leave_type       text,
  half_leave       boolean not null default false,
  computed_at      timestamptz not null default now(),
  primary key (employee_id, work_date)
);

create table month_locks (
  office_id      text not null references offices(id),
  month          date not null,
  reviewed_by    text references employees(id),
  reviewed_at    timestamptz,
  locked_by      text references employees(id),
  locked_at      timestamptz,
  primary key (office_id, month)
);

-- Frozen at lock time. Payslips read only from here.
create table payslips (
  employee_id    text not null references employees(id),
  month          date not null,
  office_id      text not null references offices(id),
  salary         numeric(12,2) not null,
  calendar_days  int not null,
  day_rate       numeric(12,2) not null,
  present        numeric(4,1) not null,
  half           numeric(4,1) not null,
  absent         numeric(4,1) not null,
  paid_leave     numeric(4,1) not null,
  unpaid_leave   numeric(4,1) not null,
  not_employed   numeric(4,1) not null,
  unpaid_days    numeric(4,1) not null,
  deduction      numeric(12,2) not null,
  net            numeric(12,2) not null,
  trace          jsonb not null,              -- [{date, label, unpaid}]
  pdf_key        text,                        -- object storage key, filled lazily
  primary key (employee_id, month)
);

create table notifications (
  id          bigserial primary key,
  user_id     text not null references employees(id),
  text        text not null,
  link        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create table email_outbox (
  id          bigserial primary key,
  to_email    text not null,
  subject     text not null,
  body        text not null,
  status      text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor_id   text not null references employees(id),
  office_id  text references offices(id),
  action     text not null,
  detail     text not null,
  before     jsonb,
  after      jsonb
);
create index on audit_log (office_id, at desc);

create table invites (
  token_hash   text primary key,              -- sha256 of the token in the email
  employee_id  text not null references employees(id),
  expires_at   timestamptz not null,
  used_at      timestamptz
);
create table sessions (
  sid          text primary key,
  employee_id  text not null references employees(id),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create table settings (key text primary key, value jsonb not null);
```

Employee IDs are assigned by the server: `EMP-` + office number + a running number per office
(a sequence per office). The terminal user ID defaults to the numeric part.

## 4. Terminal ingestion (ADMS push)

Each terminal is set to ADMS mode with the server address and port in its Cloud Server page. It
then calls the server by itself. The server never calls the terminal.

Endpoints the device uses (all plain text, no cookies, no JSON):

| Request from the device | What the server does | Reply |
| --- | --- | --- |
| `GET /iclock/cdata?SN=<serial>&options=all...` | Handshake. Look up the terminal by `SN`, update `last_seen_at`. | The option block below |
| `POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=<n>` | Body holds one punch per line. Insert them. | `OK: <number of lines>` |
| `POST /iclock/cdata?SN=<serial>&table=OPERLOG...` | User and device operations. Store nothing, acknowledge. | `OK` |
| `GET /iclock/getrequest?SN=<serial>` | Device asks for pending commands every few seconds. Update `last_seen_at`. | `OK` |
| `POST /iclock/devicecmd?SN=<serial>` | Result of a command. | `OK` |

Handshake reply:

```
GET OPTION FROM: <serial>
Stamp=<att_stamp or 0>
OpStamp=9999
ErrorDelay=30
Delay=10
TransTimes=00:00;14:05
TransInterval=1
TransFlag=TransData AttLog
TimeZone=5.5
Realtime=1
Encrypt=None
```

`Realtime=1` makes the device send each punch as it happens. `Stamp` tells it where to resume, so
after an outage it uploads everything it kept.

An ATTLOG line is tab separated: `PIN  YYYY-MM-DD HH:MM:SS  status  verify  workcode ...`.
Only the first two fields matter here. The app does not use the device's in/out status, because
the rule is "first and last punch of the day".

Ingestion steps for each line:

1. Parse `PIN` and the device time. Treat the time as `Asia/Kolkata`.
2. Insert into `punches` with `on conflict do nothing` (the unique key makes retries harmless).
3. Resolve `employee_id` from `employees.terminal_user_id`. If unknown, keep the row with a null
   employee and show it on the Terminals screen. When the PIN is assigned later, backfill.
4. Recompute `attendance_days` for that employee and date (section 5).
5. Reply `OK: n` only after the transaction commits. If you reply before, a crash loses punches.

Other points:

- A punch at another office's terminal is accepted. `punches.terminal_id` gives the office, and
  the day gets `other_office_id` so the register can flag it.
- "Terminal offline" on the app means `now() - last_seen_at > 2 minutes` (the device polls
  `getrequest` every `Delay` seconds).
- Put a secret in the path or check the source serial against `terminals.serial`. Unknown serials
  get `OK` and are logged, nothing is stored. The device cannot send custom headers.
- Many devices only speak plain HTTP. If yours does, expose a dedicated HTTP port for `/iclock`
  only and keep `/api` on HTTPS.
- Field details vary between firmware versions. You already have a working local listener, so log
  the full request line and body from your device for a day and adjust the parser to what it sends.

The mock stands in for this with `api.simulatePunch()` (Terminals screen, "Demo: send one punch").

## 5. Attendance rules

Reference implementation: `classifyDay()` in `src/lib/rules.ts`, with tests in `src/api/api.test.ts`.
Port both to the backend and keep them passing.

Calendar for an office and a date, in this order:

1. A `working` entry in `holidays` for that office makes it a working day.
2. A `holiday` entry makes it a holiday.
3. Sunday, or the 2nd or 4th Saturday of the month, is a weekly off.
4. Otherwise it is a working day (Monday to Saturday).

Status for an employee on a working day:

| Situation | Status | Unpaid |
| --- | --- | --- |
| Date before joining | Before joining | 1 (every calendar day, see section 8) |
| Approved full day leave | On leave (CL / PL / Unpaid) | 0, or 1 for unpaid leave |
| Approved half day leave | Half day leave | 0.5 if unpaid leave, plus 0.5 if under 4.5 h worked |
| No punch, past day | Absent | 1 |
| No punch, today | Not yet in | 0 |
| One punch, past day | Missing punch | 0, and it blocks the month lock |
| One punch, today | In office | 0 |
| Under 4.5 h between first and last punch | Absent | 1 |
| First punch after 9:00 | Half day (late) | 0.5 |
| 4.5 h or more, under 9 h | Half day (short hours) | 0.5 |
| 9 h or more, in by 9:00 | Present | 0 |

Details:

- 9:00:59 is on time. Compare at minute precision: late means first punch minute > 09:00.
- Punches within 2 minutes of the previous one are treated as one punch (double taps).
- A manual entry replaces the in time, the out time or both. The raw punches stay. The day
  carries `manual = true` and the app shows the Manual tag.
- Today is never judged early. Until the hours are complete it stays "In office".
- A late first punch with under 4.5 h is Absent, not Half day.
- Punches on a weekly off or holiday are stored and ignored.

`attendance_days` is a cache. Rebuild the affected rows when any input changes: a punch arrives,
a manual entry is written, a leave is approved or undone, a holiday changes (all employees of the
office for that date), an employee's join date changes. A nightly job at 00:05 closes yesterday
(turns "Not yet in" into Absent and "In office" with one punch into Missing punch). Once the
month is locked the rows are not rebuilt again.

On-time rate on Home = check-ins at or before 9:00 divided by expected check-ins (working days
that are not full day leave), month to date. The streak is the number of consecutive Present days
counted backwards, skipping offs, holidays and full day leave.

## 6. Leave rules

- Types: CL, PL (both paid) and Unpaid.
- Each employee has a yearly quota per type. 1/12 of it is credited on the 1st of every month by
  a job that inserts `credit` rows into `leave_ledger` (the unique index makes the job safe to rerun).
  Someone who joins after the 1st gets the first credit on the next 1st.
- Days charged = working days of the employee's office between the two dates. Offs and holidays
  inside the range are free. A half day is 0.5 and only for a single date.
- Paid leave cannot exceed the balance. Check twice: when applying (balance minus pending) and
  when approving (balance). Unpaid leave has no limit.
- Approval inserts a negative `leave` row in the ledger. Undo and cancellation remove it.
- Overlapping pending or approved leave for the same person is rejected.
- Year end job (31 Dec, after the December credit): CL balance is written off with a `lapse` row,
  PL above 30 is written off the same way, so PL carries over up to 30.
- The leave year is the calendar year. Change the job if your year runs April to March.

## 7. Requests, undo and escalation

Leave requests and correction requests share one workflow.

- Decider: the head of the employee's office. For a head's own request, the admin.
  The admin may decide any request.
- Approve is one call. Reject needs a comment, which the employee sees.
- Approving a correction writes `manual_days` from the request and rebuilds that day.
- Undo: `POST /requests/{id}/undo` puts the request back to pending. Allowed for 30 seconds and
  only for the person who decided. Store `decided_at` and compare on the server. The app shows
  Undo in a toast for 5 seconds.
- The employee can cancel a pending request and restore it right after (same toast).
- Escalation: a pending request is escalated when 2 working days of that office have fully
  passed since the day it was created. An hourly job finds requests that just crossed the line,
  notifies the admin once (keep an `escalated_at` column if you want exactly-once), and from then
  on the request appears in the admin's queue with the Escalated tag. The head can still decide it.
- The Home queue (`GET /requests/queue`) returns: for a head, pending requests of their office
  except their own. For the admin, requests from heads plus escalated ones.

## 8. Payroll and the month lock

For one employee and one month:

```
salary        = latest salary revision with effective_month <= month
day_rate      = salary / calendar days in the month        (30 for November, 31 for October)
unpaid_days   = absent days + 0.5 x half days + unpaid leave days + calendar days before joining
deduction     = round(day_rate x unpaid_days, 2)
net           = round(salary - deduction, 2)
```

Totals are the sums of the rounded rows, so the page and the payslips always agree.
Sample check, Office 1, November 2026: 22 people, salary 8,52,000, 12 unpaid days, deductions
12,666.67, net 8,39,333.33. The test `month end: resolve, review, lock, payslips` asserts this.

Month end for an office head (the checklist on the Payroll screen):

1. Resolve every Missing punch in the month (approve the correction, or enter the time).
2. Decide every pending request that touches the month.
3. Mark the salaries as reviewed.
4. Lock. Allowed only after the last day of the month.

Lock, in one transaction: take `select ... for update` on the `month_locks` row, re-check steps
1 to 3, compute all rows, insert them into `payslips`, set `locked_by` and `locked_at`, write the
audit entry, queue one notification and one email per employee.

After the lock, for that office and month, the server rejects with 409: manual entries,
correction and leave requests or decisions, holiday changes, salary revisions effective in that
month, and it stops rebuilding `attendance_days`. Late punches are still stored in `punches`
(raw data is never refused) but do not change the locked figures. Show them to the admin.

Unlock is admin only and needs a reason. It deletes the office's payslips for the month, clears
the lock and the review, writes the audit entry and notifies the head. The head then goes through
the checklist again.

## 9. Notifications and email

Every event writes a row in `notifications` (the bell in the app polls `GET /notifications`
every 15 seconds) and a row in `email_outbox`. A worker sends the outbox through an email API
(Resend, Postmark or SES) with retries. Never send email inside the request.

| Event | Who is told |
| --- | --- |
| Leave or correction requested | The decider (head, or admin for a head's request) |
| Request approved, rejected, or a decision undone | The employee |
| Request escalated | Admin |
| Day corrected by hand | The employee |
| Salary changed | The employee (no amount in the message) |
| Month locked | Every employee of the office: "Your November payslip is ready" |
| Month unlocked | The office head |
| Employee added | The employee: invite link to set a password |
| Made office head | The new head |

## 10. Audit log

Write one row for each of these, inside the same transaction as the change: employee added,
edited, switched off or on; salary changed (no amount in `detail`, amounts only in `before` and
`after`, which are visible to the admin only); request approved, rejected, undone; manual
correction; holiday added or removed; month reviewed, locked, unlocked; office edited; head
changed; settings changed. The log is append only. Heads see their office's rows.

## 11. Auth and security

- Passwords: argon2id. Minimum 8 characters.
- Session: random 32 byte id in an `httpOnly`, `Secure`, `SameSite=Lax` cookie, stored in
  `sessions`, 12 hour sliding expiry. Because the cookie is `SameSite=Lax` and every write is a
  JSON `POST/PUT/PATCH/DELETE`, also require the `Content-Type: application/json` header and
  check the `Origin` header on writes.
- Invite: a random token emailed as `/invite/<token>`, stored hashed, valid 7 days, single use.
  "Forgot password" is the same mechanism: the head sends a new invite link.
- Rate limit `/auth/login` and `/auth/invites/*` (for example 10 per minute per IP and per email).
- `/iclock/*` has no session. Protect it as described in section 4.
- Never trust an office id or employee id from the client without `can()`.
- Return 404, not 403, when an employee asks for someone else's data by id.

## 12. API conventions

- Base path `/api`. JSON in and out. The full list is in `docs/openapi.yaml`, and each function
  in `src/api/index.ts` has the matching endpoint in the comment above it.
- Errors: `{ "message": "text for the user" }` with a status code. The app shows `message` as is,
  so write it for the person, for example "Priya Nair has only 1.5 days of CL left."
  - 401 not signed in (the app sends the user to the login screen)
  - 403 not allowed
  - 404 not found
  - 409 the state does not allow it (locked month, already decided, duplicate)
  - 422 the input is wrong (missing reason, bad dates)
- Money is a JSON number with two decimals. Days are numbers in steps of 0.5.
- Lists are small (50 people), so there is no pagination except `GET /audit`, which returns the
  latest 200 rows and takes `before=<id>` for older ones.

## 13. Payslip PDF

`GET /payslips/{employeeId}/{month}/pdf` returns `application/pdf`. Render the same layout as
`PayslipSheet` in `src/shared.tsx` (A4, one page) from the `payslips` row. Two workable ways:
`pdfkit` or `pdfmake` drawing the layout in code (small, no browser), or Playwright printing an
HTML template (exact match with the screen, heavier image). Generate on first request, store the
file key in `payslips.pdf_key`, and delete it on unlock. In the app, make `api.payslipPdfUrl()`
return this URL and the button switches from printing to downloading by itself.

## 14. Scheduled jobs

| When (IST) | Job |
| --- | --- |
| 00:05 daily | Close yesterday in `attendance_days` for everyone |
| 00:10 on the 1st | Monthly leave credit |
| 23:30 on 31 Dec | Year end: CL lapse, PL cap at 30 |
| Hourly, 9:00 to 19:00 | Escalate requests pending 2 working days |
| Every minute | Send the email outbox |
| Every 5 minutes | Mark terminals offline, notify the head if one is silent for 15 minutes in office hours |

Use `node-cron` in the same process, or `pg-boss` if you want retries stored in Postgres.

## 15. Deployment

- Railway: one Node service and one Postgres. Set `TZ=Asia/Kolkata`, `DATABASE_URL`,
  `SESSION_SECRET`, `APP_URL`, `EMAIL_API_KEY`, `ICLOCK_SECRET`.
- Serve the built app (`npm run build`, folder `dist/`) from the same service, with every unknown
  path that does not start with `/api` or `/iclock` falling back to `index.html`. Same origin
  means no CORS and the cookie just works.
- The terminals need to reach the server over the internet. Give the service a fixed domain and
  enter it in each device's Cloud Server page. Test with one device before enrolling the others.
- Back up Postgres daily. `punches` is the one table that cannot be rebuilt from anything else.

## 16. Connecting the app to the backend

1. Add `src/api/http.ts` with one helper: `fetch('/api' + path, { credentials: 'include', ... })`,
   throw `new ApiError(status, body.message)` when the response is not ok.
2. In `src/api/index.ts`, replace each function body with a call to that helper. Keep names,
   parameters and return types. The screens do not change.
3. Delete `seed.ts`, `db.ts`, `calc.ts` and the `demo` block, and remove the demo clock from the
   profile menu in `src/layout.tsx`. Replace `api.demo.now()` in the screens with the real clock.
4. On a 401 from any call, clear the user in `AuthProvider` so the guard sends them to the login.
5. Keep `src/lib/rules.ts` in the app only for `RULES` (the day card uses the 9 hour target).

## 17. Assumptions to confirm

These are choices made where the brief was silent. Each one is a small change if you disagree.

1. Leave year is January to December.
2. A late first punch is still on time at 9:00 and late from 9:01.
3. Half day leave: the worked half needs 4.5 h and the 9:00 rule does not apply that day.
4. A person who joins mid month is paid from the joining date (calendar days before it are unpaid).
5. Pending requests for a month block its lock, the same way missing punches do.
6. Undo of a decision is allowed for 30 seconds and only for the decider.
7. Totals add up the rounded per-person amounts.
8. The admin account is not an employee: no attendance, leave or payslip.
9. Default quotas are CL 12 and PL 18 per year. Holidays in the sample data are placeholders.
10. Double punches within 2 minutes count as one.
