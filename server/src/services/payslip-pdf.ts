// The payslip as a one-page A4 PDF, drawn with pdfkit from the locked payroll item.
import PDFDocument from 'pdfkit';
import { fmtDate, fmtDay, fmtMonth } from '../lib/time';
import type { Payslip } from './payroll';

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The built-in PDF fonts have no rupee sign, so amounts are written as "Rs.".
const money = (n: number) => `Rs. ${inr.format(n)}`;
/** '2026-12-01T10:00' as '1 Dec 2026, 10:00 AM' */
function stamp(t: string): string {
  if (!t) return '';
  const [h, m] = t.slice(11, 16).split(':').map(Number);
  return `${fmtDay(t.slice(0, 10))} ${t.slice(0, 4)}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The lines of the payslip, shared by the PDF and its tests. */
export function payslipContent(p: Payslip) {
  const r = p.row;
  return {
    title: `Payslip for ${fmtMonth(p.month)}`,
    company: p.company, office: p.employee.officeName,
    employee: [['Employee', p.employee.name], ['Employee code', p.employee.code], ['Designation', p.employee.designation || '-'], ['Office', p.employee.officeName], ['Month', fmtMonth(p.month)]] as [string, string][],
    attendance: [
      ['Calendar days in the month', String(r.calendarDays)], ['Present', num(r.present)], ['Half days', num(r.half)], ['Absent', num(r.absent)],
      ['Paid leave (CL / PL)', num(r.paidLeave)], ['Unpaid leave', num(r.unpaidLeave)],
      ...(r.notEmployed > 0 ? [['Calendar days not employed', num(r.notEmployed)] as [string, string]] : []),
      ['Unpaid days', num(r.unpaidDays)],
    ] as [string, string][],
    pay: [['Monthly salary', money(r.salary)], [`Day rate (salary / ${r.calendarDays} days)`, money(r.dayRate)], [`Deduction for ${num(r.unpaidDays)} unpaid ${r.unpaidDays === 1 ? 'day' : 'days'}`, `- ${money(r.deduction)}`]] as [string, string][],
    net: ['Net salary', money(r.net)] as [string, string],
    trace: r.trace.map(t => [`${fmtDate(t.date)}  ${t.label}`, num(t.unpaid)] as [string, string]),
    footer: `Locked on ${stamp(p.lockedAt)}${p.lockedByName ? ` by ${p.lockedByName}` : ''}. This is a computer generated payslip and needs no signature.`,
  };
}

export function payslipPdf(p: Payslip): Promise<Buffer> {
  const c = payslipContent(p);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${c.title} - ${p.employee.name}`, Author: c.company } });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50; const right = 545; const ink = '#1b2430'; const muted = '#6b7280'; const line = '#d9dde3';
    const rule = () => { doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor(line).lineWidth(0.7).stroke(); doc.moveDown(0.6); };
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10.5).fillColor(bold ? ink : muted).text(label, left, y, { width: 330 });
      const after = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(ink).text(value, left + 330, y, { width: right - left - 330, align: 'right' });
      doc.y = Math.max(after, doc.y) + 4;
    };
    const section = (title: string) => { doc.moveDown(0.8); doc.font('Helvetica-Bold').fontSize(9).fillColor(muted).text(title.toUpperCase(), left, doc.y, { characterSpacing: 0.8 }); doc.moveDown(0.4); rule(); };

    doc.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(c.company, left, 50);
    doc.font('Helvetica').fontSize(11).fillColor(muted).text(c.office);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(ink).text(c.title);
    doc.moveDown(0.3);

    section('Employee'); c.employee.forEach(([k, v]) => row(k, v));
    section('Attendance summary'); c.attendance.forEach(([k, v]) => row(k, v));
    section('Pay'); c.pay.forEach(([k, v]) => row(k, v));
    doc.moveDown(0.2); rule(); row(c.net[0], c.net[1], true);

    if (c.trace.length) {
      section('Unpaid days in detail');
      // Kept to one page: a long list is cut with a note.
      const shown = c.trace.slice(0, 14);
      shown.forEach(([k, v]) => row(k, v));
      if (c.trace.length > shown.length) row(`and ${c.trace.length - shown.length} more`, '');
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(c.footer, left, 780, { width: right - left, align: 'center', lineBreak: false });
    doc.end();
  });
}
