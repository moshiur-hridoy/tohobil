import { describe, expect, it } from 'vitest';
import { advanceOf, monthsAhead } from './advance';

const TODAY = '2026-10-31';
const due = (period: string, outstanding = '0', amount = '500000') => ({
  period,
  kind: 'monthly',
  amount_paisa: amount,
  outstanding_paisa: outstanding,
  due_date: `${period}-20`,
});

describe('advanceOf', () => {
  it('nothing ahead when only the past months are paid', () => {
    expect(advanceOf([due('2026-09'), due('2026-10')], '0', TODAY)).toEqual({ months: 0, through: null, extra: 0n });
  });

  it('counts paid months ahead, then the credit in whole months', () => {
    // November already generated and paid, plus 10,000 of credit at 5,000 a month: up to January
    expect(advanceOf([due('2026-10'), due('2026-11')], '1000000', TODAY)).toEqual({ months: 3, through: '2027-01', extra: 0n });
  });

  it('keeps what is short of a whole month as extra', () => {
    expect(advanceOf([due('2026-10')], '700000', TODAY)).toEqual({ months: 1, through: '2026-11', extra: 200000n });
  });

  it('an open month ahead stops the count', () => {
    expect(advanceOf([due('2026-11'), due('2026-12', '500000')], '0', TODAY)).toEqual({ months: 1, through: '2026-11', extra: 0n });
  });

  it('levy and other dues are not months ahead', () => {
    expect(advanceOf([due('2026-10'), { ...due('2026-12'), kind: 'levy' }], '0', TODAY).months).toBe(0);
  });
});

describe('monthsAhead', () => {
  it('a month already paid as advance is not offered again', () => {
    // December is the last due; January was paid ahead and accepted, so it sits as credit
    expect(monthsAhead('2026-12', 500000n, '500000', 2).map((m) => m.period)).toEqual(['2027-02', '2027-03']);
  });

  it('a part-paid month asks only for the rest', () => {
    expect(monthsAhead('2026-12', 500000n, '200000', 1)).toEqual([{ period: '2027-01', need: 300000n }]);
  });
});
