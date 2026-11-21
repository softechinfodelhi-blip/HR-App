# Backend map: screens to endpoints

Status: built. All eight phases are done. This file is the map the work followed, with the decisions made along the way.

The frontend reaches data only through `src/api/index.ts` (one function per endpoint, ~60 functions).
Each function is a `fetch` through the typed client in `src/api/http.ts`, and screens read through the
TanStack Query hooks in `src/api/hooks.ts`, which keep the `{ data, error, loading, reload }` shape the markup expects.

Conventions
- Base `/api`, JSON. Errors are `{ message }` with 401 / 403 / 404 / 409 / 422 (the UI shows `message` as is).
- Dates `YYYY-MM-DD`, months `YYYY-MM`, clock `HH:mm`, timestamps as IST local `YYYY-MM-DDTHH:mm`
  (what `lib/format.ts` expects). Stored as UTC `timestamptz`.
- `office` query param: an office id or `all` (admin only). A head sending any other office gets 403.
- Lists take `office, month, status, search, page, pageSize` and return `{ items, total, page, pageSize }`.
  The client unwraps `items`, so screens keep receiving arrays.

## Screen map

| Screen (route) | Endpoints |
| --- | --- |
| Login `/login` | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, **new** `POST /auth/forgot` |
| Set password `/invite/:token` | `GET /auth/invites/:token`, `POST /auth/invites/:token` |
| **New** reset `/reset/:token` (reuses the SetPassword screen) | `GET /auth/reset/:token`, `POST /auth/reset/:token` |
| Shell: office switcher, bell, Ctrl+K, profile menu | `GET /offices`, `GET /notifications`, `POST /notifications/read`, `GET /search?q=&office=` (demo clock menu removed) |
| Home `/` (admin and head) | `GET /attendance/today?office=` + **SSE** `GET /live?office=` (replaces polling), `GET /requests/queue?office=`, `GET /me/home` (head's own card), admin: `GET /overview` (office cards: headcount, in today, terminal, on-time rate, office of the month) |
| People `/people` | `GET /employees?office=&status=&search=`, `POST /employees`, `DELETE /employees/:id` (undo, only while invited), `GET /settings` (default quotas) |
| Profile `/people/:id` | `GET /employees/:id`, `PATCH /employees/:id` (details, terminal user id, **new** last working date), `PUT /employees/:id/quota` (year's CL/PL), `POST /employees/:id/salary`, `POST /employees/:id/invite`, `POST /employees/:id/status`, **new** `GET /employees/:id/ledger`, `POST /employees/:id/leave-adjustments`, `GET /employees/:id/badges` |
| Offices `/people/offices` (admin) | `GET /offices`, **new** `POST /offices`, `PATCH /offices/:id` (name, address, start time, full day, half day hours), `PUT /offices/:id/head` |
| Register `/attendance` + day drawer | `GET /attendance/register?office=&month=`, `GET /attendance/days/:employeeId/:date` (with raw punches), `PUT /attendance/days/:employeeId/:date/manual` (head's direct fix, stored as a correction approved by the head) |
| Corrections `/attendance/corrections` | `GET /requests?kind=correction&status=&office=`, `POST /requests/:id/decision`, `POST /requests/:id/undo`, **new** `POST /requests/:id/reverse` (admin) |
| Terminals `/attendance/terminals` | `GET /devices`, `GET /devices/punches?office=`, **new** `GET /devices/unregistered`, `POST /devices` (register a serial to an office), `PATCH/DELETE /devices/:id`, `GET /punches/unmatched?office=`. "Demo: send one punch" is replaced by `server/scripts/replay-attlog.ts` |
| Leave requests `/leave` | `GET /requests?kind=leave&status=&office=`, decision / undo / reverse as above, **new** `POST /requests/:id/cancel-approved` (head or admin) |
| Leave calendar `/leave/calendar` | `GET /leave/calendar?office=&month=` |
| Holidays `/leave/holidays` | `GET /holidays?office=&year=`, `POST /holidays`, `DELETE /holidays/:id`. One endpoint for both tables: `kind` = `holiday` (holidays), `working` or `off` (calendar_overrides). **New** option "Office closed" (kind `off`) |
| Payroll `/payroll` | `GET /payroll?month=` (one line per office), `GET /payroll/:officeId/:month` (rows + checklist), `POST .../review`, `POST .../lock`, `POST .../unlock` (admin), `GET .../summary` (lock summary) |
| Payslips `/payroll/payslips`, `/payroll/payslips/:emp/:month` | `GET /payslips?office=&month=`, `GET /payslips/:employeeId/:month`, `GET /payslips/:employeeId/:month/pdf` |
| Organisation `/settings` (admin) | `GET /settings`, `PATCH /settings` (company name, default quotas, PL carry cap, escalation days) |
| Audit log `/settings/audit` | `GET /audit?office=&search=&page=` |
| My home `/me` | `GET /me/home` (today, missing punches, streak, badges, balances, pending, next holiday, latest payslip) |
| My attendance `/me/attendance` | `GET /me/attendance?month=` |
| Correction `/me/correction/:date` | `GET /attendance/days/:me/:date`, `POST /corrections` |
| My leave `/me/leave` | `GET /me/balances`, `GET /me/requests`, `POST /requests/:id/cancel`, `POST /requests/:id/restore` |
| Apply leave `/me/leave/apply` | `POST /leave/preview`, `POST /leave` |
| My payslips `/me/payslips`, `/me/payslips/:month` | `GET /me/payslips`, `GET /payslips/:me/:month`, `.../pdf` |
| My profile `/me/profile` | `GET /employees/:me`, `POST /auth/password` |
| System | `GET /health` |

ADMS port only (`ADMS_PORT`, default 8081): `GET/POST /iclock/cdata`, `GET /iclock/getrequest`,
`POST /iclock/devicecmd`. Every other path on that port returns 404.

## Where the spec and the frontend differ (the spec wins)

| Topic | Frontend / design doc today | Built as |
| --- | --- | --- |
| Net salary | rounded to paise (Office 1 Nov = ₹8,39,333.33) | rounded to the nearest rupee; the sample total changes |
| ADMS handshake | `Stamp=`, `OpStamp=`, `TimeZone=5.5` | `ATTLOGStamp=`, `OPERLOGStamp=9999`, no TimeZone |
| Undo window | 30 s on the server | 60 s on the server (toast stays 5 s) |
| Invite link | valid 7 days, no reset | 72 h, plus forgot / reset password |
| Badges | 7, 14, 30 days, full month | 10, 25, 50, 100 days, Perfect month, stored in `badges` |
| Half-day leave | boolean `half`; worked half needs 4.5 h; 9:00 rule skipped | `half_day` none / first / second; classify normally, then a CL/PL half day lifts a half-day status to paid 1 |
| Holidays | one row covers several offices, `kind` holiday or working | `holidays` per office + `calendar_overrides` (working / off); API groups rows so the screen still gets `officeIds[]` |
| Quotas | `clQuota` / `plQuota` on the employee | `leave_quotas` per year; employee shows the current year |
| Balances | computed from quota and approved requests | sum of `leave_ledger` only |
| Head's direct fix | `manual_days` row | a correction request approved by the head (decided_by, decided_at) |
| Employee id | `EMP-0117` is the primary key | uuid primary key + `code` (`EMP-0117`) shown in the UI |
| Lists | plain arrays | paginated `{ items, total }` |
| Email | outbox, external API | nodemailer SMTP, sent by a cron worker from an `email_outbox` table so a request never waits on SMTP |
| Terminal offline | silent over 2 min | "Offline" on screen after 5 min silence; alert job for over 12 h on a working day |
| ORM | Kysely / Drizzle / pg | Prisma with migrations |

## Assumptions

1. Server lives at `sbm-hr-app/server`, and one root `package.json` builds both, so Railway runs a single service.
2. The admin is not an employee: no attendance, leave or payslips (matches the frontend).
3. One head per office. "Add office head" = add an employee with role head, or promote one.
4. `SessionUser.id` stays the employee id for heads and employees (the screens compare it with
   `employeeId`), and is the user id for the admin.
5. Punches less than 2 minutes after the previous one count as one punch (a double tap), so a double
   tap is MISSING_PUNCH, not ABSENT under 4.5 h.
6. Today is shown live (`not_in`, `working`) and not judged until the 23:55 finalize. `future` and
   `not_joined` are computed when read and never stored.
7. Late means the first punch is after 09:00:59 at the office's `start_time` (per office).
8. The monthly credit includes the joining month only when the joining date is the 1st.
9. Dec 31 job runs after the Dec credit: CL is written off to 0, PL is capped at `pl_carry_cap`, both as ledger rows.
10. A month can be locked only after its last day, and the existing "salaries reviewed" step stays as
    a lock condition (the checklist screen has it).
11. Escalation runs hourly from 09:00 to 19:00 IST; "N working days" counts working days that have fully passed in that office's calendar.
12. Salary amounts never go in notification text or email subjects. The audit log stores old and
    new values, and only the admin can see salary amounts there.
13. Office of the month = highest on-time rate for the previous full month (check-ins by start time
    divided by expected check-ins, as on Home today).
14. Supabase: `DATABASE_URL` = pooled connection (port 6543), plus `DIRECT_URL` (port 5432) for
    Prisma migrations. That adds one env var to the spec list.
15. Existing frontend tests run against the mock. In Phase 7 they are rewritten against a mocked
    fetch layer; rule tests move to the server.

## Decisions (confirmed 2026-11-21)

1. Features with no screen today get small controls built only from the existing components. No new styles.
2. Apply Leave gets a First half / Second half choice (`half_day` = first or second).
3. An approved half-day CL/PL on a day that is otherwise ABSENT (under 4.5 h worked) pays 0.5. The half day still comes off the balance.
4. Git: one commit per phase. Nothing is pushed.
5. Development database: `embedded-postgres` (real Postgres binaries, no installer). Its data folder is kept
   outside OneDrive, in `%LOCALAPPDATA%\sbm-hr\pgdata`. Supabase from Phase 8.
