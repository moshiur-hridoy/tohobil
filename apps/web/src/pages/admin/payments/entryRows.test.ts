import { describe, expect, it } from 'vitest';
import { amountForTap, entryRows, type EntryPreview, type PreviewItem } from './entryRows';

const TODAY = '2026-10-22';
const due = (period: string, outstanding: string, extra: Partial<PreviewItem> = {}): PreviewItem => ({
  due_id: `d-${period}`,
  period,
  kind: 'monthly',
  due_date: `${period}-20`,
  ahead: `${period}-20` > TODAY,
  amount_paisa: '1000000',
  outstanding_paisa: outstanding,
  ...extra,
});
// M01 in the owner's report: 2 shares (10,000 a month), November and December already generated.
const m01: EntryPreview = {
  items: [due('2026-11', '1000000'), due('2026-12', '1000000')],
  credit_paisa: '0',
  monthly: { period: '2026-12', amount_paisa: '1000000' },
};

describe('entryRows', () => {
  it('one row per month at the monthly price, never two months summed', () => {
    const { rows } = entryRows(m01, 0n, TODAY);
    expect(rows.map((r) => [r.period, r.need])).toEqual([
      ['2026-11', 1000000n],
      ['2026-12', 1000000n],
      ['2027-01', 1000000n],
      ['2027-02', 1000000n],
    ]);
  });

  it('extra money runs forward into the months ahead instead of one lump of credit', () => {
    const { rows, leftover } = entryRows(m01, 20000000n, TODAY); // 2,00,000 taka
    expect(rows.filter((r) => r.covered === r.need).map((r) => r.period)).toEqual([
      '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05',
      '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12',
    ]);
    // 14 months is 1,40,000; twelve months ahead is the most offered, so 60,000 stays as credit
    expect(leftover).toBe(6000000n);
  });

  it('a partial amount fills the oldest month first and leaves the rest of it open', () => {
    const { rows, leftover } = entryRows(m01, 200000n, TODAY); // 2,000 taka
    expect(rows[0]).toMatchObject({ period: '2026-11', covered: 200000n, need: 1000000n });
    expect(rows[1]!.covered).toBe(0n);
    expect(leftover).toBe(0n);
  });

  it('overdue months, then fines, then the months not due yet', () => {
    const preview: EntryPreview = {
      items: [due('2026-09', '500000'), { fine_id: 'f1', period: '2026-09', kind: 'fine', due_date: null, ahead: false, amount_paisa: '50000', outstanding_paisa: '50000' }, due('2026-11', '500000')],
      credit_paisa: '0',
      monthly: { period: '2026-11', amount_paisa: '500000' },
    };
    const { rows } = entryRows(preview, 550000n, TODAY);
    expect(rows.slice(0, 3).map((r) => [r.kind, r.status, r.covered])).toEqual([
      ['monthly', 'overdue', 500000n],
      ['fine', 'overdue', 50000n],
      ['monthly', 'advance', 0n],
    ]);
  });

  it('credit already held pays the months ahead first, so they ask only for the rest', () => {
    const { rows } = entryRows({ ...m01, credit_paisa: '1500000' }, 0n, TODAY);
    // January is covered by the old credit, February half
    expect(rows.slice(2).map((r) => [r.period, r.need])).toEqual([['2027-02', 500000n], ['2027-03', 1000000n]]);
  });

  it('levy and special money has no months ahead: anything extra is credit', () => {
    const { rows, leftover } = entryRows({ items: [due('2026-10', '300000', { kind: 'levy' })], credit_paisa: '0', monthly: null }, 500000n, TODAY);
    expect(rows).toHaveLength(1);
    expect(leftover).toBe(200000n);
  });
});

describe('amountForTap', () => {
  it('tapping a month pays everything up to it; tapping a paid one stops just before it', () => {
    const { rows } = entryRows(m01, 0n, TODAY);
    expect(amountForTap(rows, 2)).toBe(3000000n);
    const filled = entryRows(m01, 3000000n, TODAY).rows;
    expect(amountForTap(filled, 1)).toBe(1000000n);
    // a half-paid month is completed, not cleared
    const half = entryRows(m01, 1500000n, TODAY).rows;
    expect(amountForTap(half, 1)).toBe(2000000n);
  });
});
