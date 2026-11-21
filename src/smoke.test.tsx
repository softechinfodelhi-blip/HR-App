// Opens every screen as each role and checks it loads real content with no error.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { AppRoutes } from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './ui';

const LOGIN = { admin: 'anita.verma@sbm.example', head: 'vikram.singh@sbm.example', employee: 'priya.nair@sbm.example' };
const SCREENS: Record<keyof typeof LOGIN, [path: string, text: RegExp][]> = {
  admin: [
    ['/', /Waiting for you/], ['/people', /Priya Nair/], ['/people/offices', /Offices and heads/], ['/people/EMP-0117', /Leave balance/],
    ['/attendance', /Attendance register/], ['/attendance/corrections', /Zoya Ansari/], ['/attendance/terminals', /Latest punches received/],
    ['/leave', /Tanvi Kulkarni/], ['/leave/calendar', /Leave calendar/], ['/leave/holidays', /Diwali holiday/],
    ['/payroll', /Office 2/], ['/payroll/payslips', /Payslips/], ['/payroll/payslips/EMP-0117/2026-10', /Net pay/],
    ['/settings', /Company name/], ['/settings/audit', /Month locked/],
  ],
  head: [
    ['/', /Karan Malhotra/], ['/people', /22 people/], ['/people/EMP-0102', /your own record/], ['/attendance', /Suresh Yadav/],
    ['/attendance/corrections', /Sneha Iyer/], ['/attendance/terminals', /Office 1/], ['/leave', /Priya Nair/], ['/leave/calendar', /Kavita/],
    ['/leave/holidays', /Year-end stock count/], ['/payroll', /Month-end checklist/], ['/payroll/payslips', /Vikram Singh/], ['/settings/audit', /Neha Kapoor/],
    ['/me', /On-time streak/], ['/me/leave', /My leave/],
  ],
  employee: [
    ['/me', /12/], ['/me/attendance', /My attendance/], ['/me/correction/2026-11-04', /Ask for a correction/], ['/me/leave', /Family function in Kochi/],
    ['/me/leave/apply', /Working days/], ['/me/payslips', /October 2026/], ['/me/payslips/2026-10', /Net pay/], ['/me/profile', /Change password/],
  ],
};

function open(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><ToastProvider><AppRoutes /></ToastProvider></AuthProvider></MemoryRouter>);
}
const settled = () => waitFor(() => expect(document.querySelector('.skeleton, .anim-spin')).toBeNull(), { timeout: 4000 });

let errors: unknown[][] = [];
beforeEach(() => { api.demo.reset(); errors = []; vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

for (const role of Object.keys(LOGIN) as (keyof typeof LOGIN)[]) {
  describe(`${role} screens`, () => {
    for (const [path, text] of SCREENS[role]) {
      it(path, async () => {
        await api.login(LOGIN[role], 'demo1234');
        open(path);
        await settled();
        expect(document.body.textContent).toMatch(text);
        expect(document.body.textContent).not.toMatch(/This did not load|does not exist/);
        expect(errors).toEqual([]);
      });
    }
  });
}

describe('guards', () => {
  it('signed out goes to the login screen', async () => {
    open('/payroll');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy());
  });
  it('an employee cannot open manager screens', async () => {
    await api.login(LOGIN.employee, 'demo1234');
    open('/payroll');
    await waitFor(() => expect(document.body.textContent).toMatch(/On-time streak/));
  });
  it('a head cannot open admin only screens', async () => {
    await api.login(LOGIN.head, 'demo1234');
    open('/settings');
    await waitFor(() => expect(document.body.textContent).toMatch(/Waiting for you/));
  });
});

describe('flows', () => {
  it('a: employee applies for leave, head approves from Home', async () => {
    await api.login(LOGIN.employee, 'demo1234');
    const emp = open('/me/leave/apply');
    await waitFor(() => expect(document.body.textContent).toMatch(/CL left after this/));
    fireEvent.change(screen.getByPlaceholderText(/short note/), { target: { value: 'Doctor visit' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Request sent/));
    emp.unmount();
    await api.logout();

    await api.login(LOGIN.head, 'demo1234');
    open('/');
    await waitFor(() => expect(document.body.textContent).toMatch(/Doctor visit/));
    const row = screen.getByText(/Doctor visit/).closest('div.px-4') as HTMLElement;
    fireEvent.click(row.querySelector('button.btn-secondary') as HTMLButtonElement);
    await waitFor(() => expect(document.body.textContent).toMatch(/Approved: Priya Nair/), { timeout: 4000 });
    expect((await api.requests({ scope: 'o1', kind: 'leave', status: 'pending' })).some(r => r.reason === 'Doctor visit')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('b: reject needs a reason, written in place', async () => {
    await api.login(LOGIN.head, 'demo1234');
    open('/attendance/corrections');
    await waitFor(() => expect(document.body.textContent).toMatch(/Karan Malhotra/));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);
    const input = await screen.findByPlaceholderText(/Reason for rejecting/);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(document.body.textContent).toMatch(/Write a reason/));
    expect((await api.requests({ scope: 'o1', kind: 'correction', status: 'pending' })).length).toBe(2);
  });

  it('c: head adds an employee from the drawer', async () => {
    await api.login(LOGIN.head, 'demo1234');
    open('/people');
    await waitFor(() => expect(document.body.textContent).toMatch(/22 people/));
    fireEvent.click(screen.getByRole('button', { name: 'Add employee' }));
    const dialog = await screen.findByRole('dialog');
    const inputs = dialog.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'Ishaan Bhatnagar' } });
    fireEvent.change(inputs[1], { target: { value: 'ishaan.bhatnagar@sbm.example' } });
    fireEvent.change(dialog.querySelector('input[inputmode="numeric"]')!, { target: { value: '30000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and send invite' }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Ishaan Bhatnagar is added as EMP-0130/), { timeout: 4000 });
    await waitFor(() => expect(document.body.textContent).toMatch(/23 people/));
    expect(errors).toEqual([]);
  });
});
