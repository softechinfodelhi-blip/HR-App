# SBM Management HR

Attendance from biometric terminals, leave and monthly salary for three offices.
React + Vite + TypeScript + Tailwind CSS + React Router. One app, three roles.

This is the complete front end running on a mock API. The backend is yours to build:
`docs/system-design.md` is the plan and `docs/openapi.yaml` is the contract.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 56 tests: rules, mock API, every screen for every role, the three flows
npm run build      # type-check, then production build in dist/
```

Node 22 (or 20.19 and newer).

## Demo accounts

The login screen has one-click buttons. Password for every account is `demo1234`.

| Role | Person | Email |
| --- | --- | --- |
| Admin | Anita Verma | anita.verma@sbm.example |
| Office head, Office 1 | Vikram Singh | vikram.singh@sbm.example |
| Office head, Office 2 | Rahul Khanna | rahul.khanna@sbm.example |
| Office head, Office 3 | Farhan Qureshi | farhan.qureshi@sbm.example |
| Employee, Office 1 | Priya Nair | priya.nair@sbm.example |

Any other employee signs in as `firstname.lastname@sbm.example`.

## Demo clock

The sample data lives in October to early December 2026. The app starts at **Mon 23 Nov 2026,
9:12 AM** and then ticks in real time, so two late arrivals show up on Home a few minutes in.
Open the profile menu (top right) to jump to 6:45 PM the same day or to **Tue 1 Dec**, which is
when November can be locked. "Reset demo data" in the same menu restores everything.
Changes are kept in the browser's localStorage.

## The three flows

1. **Leave.** Sign in as Priya, Leave, Apply for leave, send. Sign in as Vikram: the request is
   under "Waiting for you" on Home. Approve is one click, with Undo in the toast.
2. **Month end.** Sign in as Vikram, profile menu, set the clock to Tue 1 Dec, open Payroll.
   Approve the two missing punches, decide the pending requests, mark the salaries reviewed,
   then press and hold to lock November. Totals land on 12 unpaid days and net ₹8,39,333.33.
   Payslips appear for everyone in Office 1.
3. **New employee.** Sign in as Vikram, People, Add employee. Use the "Demo: open the invite link"
   link in the green banner, set a password, and you land on the new employee's first-day home.

Also worth a look: Ctrl+K search, the register (click any cell), the admin's office switcher,
and Office 3's offline terminal on the admin Home.

## Folder map

```
src/
  main.tsx, App.tsx     entry and the route table (role guards live here)
  index.css             Tailwind + the design tokens (colors, fonts, motion)
  types.ts              every data shape, shared with the API contract
  ui.tsx                design system: Button, Card, Drawer, Toast with Undo, Ring, states
  shared.tsx            status chip, request row (approve / reject), day drawer, A4 payslip
  layout.tsx            admin and head shell, employee shell, Ctrl+K search, bell, profile menu
  auth.tsx              session context
  lib/
    format.ts           dates, times, money (Indian grouping)
    rules.ts            attendance, leave and payroll rules as pure functions
  api/
    index.ts            the only thing screens import. One function per endpoint
    seed.ts, db.ts, calc.ts   the mock behind it (delete these when the backend is live)
  pages/
    Login.tsx           sign in, set password from an invite
    admin/              Home, People, Attendance, Leave, Payroll (+ Settings, Audit log)
    me/                 employee home, attendance, leave, payslips, profile
docs/
  system-design.md      data model, terminal ingestion, rules, lock, jobs, security
  openapi.yaml          REST contract, validated OpenAPI 3.0
```

## Roles in the app

- **Admin** and **office heads** use the same screens: Home, People, Attendance, Leave, Payroll.
  The admin has an office switcher (All, Office 1, 2, 3), "Offices and heads" and Settings.
  A head is pinned to one office and cannot change their own record.
- A head is also an employee. "My attendance, leave and payslips" in the profile menu opens
  the employee screens for them.
- **Employees** get four tabs: Home, Attendance, Leave, Payslips.

## Connecting the backend

Every screen calls `api.something()` from `src/api/index.ts`. Each function has its REST endpoint
in the comment above it. Replace the function bodies with `fetch` calls and nothing else in the
app changes. Section 16 of the system design lists the steps.

## Notes

- The app uses client-side routes. In production, serve `index.html` for any path that is not a file.
- Fonts (Source Serif 4, Inter) load from Google Fonts in `index.html`. Self-host them if the
  office network blocks that.
- Payslip: the page shows an A4 preview and prints to one page. When the backend serves the PDF,
  return its URL from `api.payslipPdfUrl()` and the button becomes a download.
