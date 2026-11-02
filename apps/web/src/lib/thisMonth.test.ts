import { describe, expect, it } from 'vitest';
import { thisMonthOf } from './thisMonth';

const due = (period: string, outstanding: string, status = 'unpaid') => ({
  period,
  outstanding_paisa: outstanding,
  due_date: `${period}-20`,
  status,
});

describe('thisMonthOf', () => {
  it('counts the current month from the 1st, with the days left to its due date', () => {
    expect(thisMonthOf([due('2026-11', '2000000')], '2026-11-02')).toEqual({ amount: 2000000n, dueDate: '2026-11-20', daysLeft: 18 });
    expect(thisMonthOf([due('2026-11', '2000000')], '2026-11-20').daysLeft).toBe(0);
  });
  it('counts only what is still open on a part-paid month', () => {
    expect(thisMonthOf([due('2026-11', '1550000', 'partial')], '2026-11-02').amount).toBe(1550000n);
  });
  it('leaves out paid, overdue and later months', () => {
    const dues = [due('2026-10', '2000000', 'overdue'), due('2026-11', '0', 'paid'), due('2026-12', '2000000')];
    expect(thisMonthOf(dues, '2026-11-02')).toEqual({ amount: 0n, dueDate: null, daysLeft: null });
  });
});
