import { daysBetween } from './dates';

interface OpenDue {
  period: string;
  outstanding_paisa: string;
  due_date: string;
  status: string;
}

export interface ThisMonth {
  /** What is still open on dues whose month has begun but whose due date has not passed. */
  amount: bigint;
  /** The earliest of their due dates, or null when nothing is open. */
  dueDate: string | null;
  /** Days from today to that date: 0 on the day itself, negative once it has passed. */
  daysLeft: number | null;
}

/**
 * The dues a member should pay now but that are not late yet, for the home card. A month's dues open
 * on the 1st and are only overdue after their due date (the server marks them `overdue`, and those
 * count as arrears instead). Dues made ahead for a later month are left out until that month begins.
 */
export function thisMonthOf(dues: readonly OpenDue[], today: string): ThisMonth {
  const month = today.slice(0, 7);
  const open = dues.filter(
    (d) => (d.status === 'unpaid' || d.status === 'partial') && d.period <= month && BigInt(d.outstanding_paisa) > 0n,
  );
  const amount = open.reduce((sum, d) => sum + BigInt(d.outstanding_paisa), 0n);
  const dueDate = open.map((d) => d.due_date).sort()[0] ?? null;
  return { amount, dueDate, daysLeft: dueDate ? daysBetween(today, dueDate) : null };
}
