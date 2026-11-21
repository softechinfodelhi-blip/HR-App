// One app, three roles. Admin and office heads share the same screens (a head is pinned to one office).
// Employees, and heads looking at their own record, use the /me screens.
import { Component, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, homeFor, useAuth } from './auth';
import { AdminLayout, EmployeeLayout } from './layout';
import { Login, SetPassword } from './pages/Login';
import Home from './pages/admin/Home';
import { Offices, People, Profile } from './pages/admin/People';
import { Corrections, Register, Terminals } from './pages/admin/Attendance';
import { Holidays, LeaveCalendar, LeaveRequests } from './pages/admin/Leave';
import { AuditLog, Organisation, Payroll, PayslipPage, Payslips } from './pages/admin/Payroll';
import MyHome from './pages/me/MyHome';
import { ApplyLeave, Correction, MyAttendance, MyLeave, MyPayslips, MyProfile } from './pages/me/My';
import type { Role } from './types';
import { Empty, ErrorBox, Spinner, ToastProvider } from './ui';

function Require({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <div className="flex h-full items-center justify-center text-slate"><Spinner size={22} /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user)} replace />;
  return <>{children}</>;
}

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="mx-auto max-w-md p-8"><ErrorBox error={this.state.error} onRetry={() => window.location.reload()} /></div>;
  }
}

function NotFound() {
  const { user } = useAuth();
  return <div className="mx-auto max-w-md p-8"><Empty icon="search" title="This page does not exist" text="The link may be old." action={<Link className="btn btn-primary" to={user ? homeFor(user) : '/login'}>Go home</Link>} /></div>;
}

export function AppRoutes() {
  const staff: Role[] = ['admin', 'head'];
  const admin: Role[] = ['admin'];
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/invite/:token" element={<SetPassword />} />

      <Route element={<Require roles={staff}><AdminLayout /></Require>}>
        <Route index element={<Home />} />
        <Route path="people" element={<People />} />
        <Route path="people/offices" element={<Require roles={admin}><Offices /></Require>} />
        <Route path="people/:id" element={<Profile />} />
        <Route path="attendance" element={<Register />} />
        <Route path="attendance/corrections" element={<Corrections />} />
        <Route path="attendance/terminals" element={<Terminals />} />
        <Route path="leave" element={<LeaveRequests />} />
        <Route path="leave/calendar" element={<LeaveCalendar />} />
        <Route path="leave/holidays" element={<Holidays />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="payroll/payslips" element={<Payslips />} />
        <Route path="payroll/payslips/:employeeId/:month" element={<PayslipPage />} />
        <Route path="settings" element={<Require roles={admin}><Organisation /></Require>} />
        <Route path="settings/audit" element={<AuditLog />} />
      </Route>

      <Route path="/me" element={<Require roles={['head', 'employee']}><EmployeeLayout /></Require>}>
        <Route index element={<MyHome />} />
        <Route path="attendance" element={<MyAttendance />} />
        <Route path="correction/:date" element={<Correction />} />
        <Route path="leave" element={<MyLeave />} />
        <Route path="leave/apply" element={<ApplyLeave />} />
        <Route path="payslips" element={<MyPayslips />} />
        <Route path="payslips/:month" element={<PayslipPage />} />
        <Route path="profile" element={<MyProfile />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <Boundary>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </Boundary>
  );
}
