// Returns a key like "signups:2026-W39" so the list automatically
// resets itself every week without any manual admin action.
export function currentWeekKey() {
  const now = new Date();
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `signups:${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
