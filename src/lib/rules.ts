// The attendance, leave and payroll rules are applied on the server (server/src/services).
// The app only needs these figures to draw the employee's day card.
export const RULES = {
  startMin: 9 * 60, // office starts 9:00 AM, a first punch at 9:01 or later is late
  fullDayMin: 9 * 60, // 9 h between the first and last punch
  halfDayMin: 270, // under 4.5 h counts as absent
};
