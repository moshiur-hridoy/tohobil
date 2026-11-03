import { describe, expect, it } from 'vitest';
import { allocationsFor, entryRows, pickedTotal, togglePick, type EntryPreview, type PreviewItem } from './entryRows';

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

  it("each month's fine sits right under that month and is paid with it", () => {
    // M06 in the owner's report: July and October open, each with a 500 taka fine
    const fine = (period: string): PreviewItem => ({ fine_id: `f-${period}`, period, kind: 'fine', due_date: null, ahead: false, amount_paisa: '50000', outstanding_paisa: '50000' });
    const preview: EntryPreview = {
      items: [due('2026-07', '500000'), due('2026-10', '500000'), fine('2026-07'), fine('2026-10'), due('2026-11', '500000')],
      credit_paisa: '0',
      monthly: { period: '2026-11', amount_paisa: '500000' },
    };
    const { rows } = entryRows(preview, 550000n, TODAY);
    expect(rows.slice(0, 5).map((r) => [r.kind, r.period, r.status, r.covered])).toEqual([
      ['monthly', '2026-07', 'overdue', 500000n],
      ['fine', '2026-07', 'overdue', 50000n],
      ['monthly', '2026-10', 'overdue', 0n],
      ['fine', '2026-10', 'overdue', 0n],
      ['monthly', '2026-11', 'advance', 0n],
    ]);
    expect(allocationsFor(rows)).toEqual([
      { due_id: 'd-2026-07', amount_paisa: '500000' },
      { fine_id: 'f-2026-07', amount_paisa: '50000' },
    ]);
  });

  it('a fine whose month is already paid keeps its place', () => {
    const preview: EntryPreview = {
      items: [due('2026-10', '500000'), { fine_id: 'f1', period: '2026-08', kind: 'fine', due_date: null, ahead: false, amount_paisa: '50000', outstanding_paisa: '50000' }],
      credit_paisa: '0',
      monthly: null,
    };
    expect(entryRows(preview, 0n, TODAY).rows.map((r) => r.key)).toEqual(['d-2026-10', 'f1']);
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

describe('togglePick', () => {
  const fine: PreviewItem = { fine_id: 'f-2026-07', period: '2026-07', kind: 'fine', due_date: null, ahead: false, amount_paisa: '50000', outstanding_paisa: '50000' };
  const preview: EntryPreview = {
    items: [due('2026-07', '500000'), due('2026-10', '500000'), fine],
    credit_paisa: '0',
    monthly: { period: '2026-10', amount_paisa: '500000' },
  };

  it('ticks a month or a fine on its own, and only those are paid', () => {
    const { rows } = entryRows(preview, 0n, TODAY);
    const onlyOct = togglePick(rows, null, 'd-2026-10');
    expect([...onlyOct]).toEqual(['d-2026-10']);
    const withFine = togglePick(rows, onlyOct, 'f-2026-07');
    expect(pickedTotal(rows, withFine)).toBe(550000n);
    const shown = entryRows(preview, 550000n, TODAY, withFine).rows;
    expect(allocationsFor(shown)).toEqual([
      { fine_id: 'f-2026-07', amount_paisa: '50000' },
      { due_id: 'd-2026-10', amount_paisa: '500000' },
    ]);
  });

  it('the first tap starts from what the typed amount already pays in full', () => {
    const { rows } = entryRows(preview, 550000n, TODAY); // July and its fine
    expect([...togglePick(rows, null, 'f-2026-07')]).toEqual(['d-2026-07']);
  });

  it('months ahead stay a run from the first one', () => {
    const { rows } = entryRows(preview, 0n, TODAY);
    const two = togglePick(rows, new Set(), 'ahead-2026-12');
    expect([...two].sort()).toEqual(['ahead-2026-11', 'ahead-2026-12']);
    expect([...togglePick(rows, two, 'ahead-2026-11')]).toEqual([]);
    // months ahead have no due yet: their money is credit, not an allocation line
    expect(allocationsFor(entryRows(preview, 1000000n, TODAY, two).rows)).toEqual([]);
  });
});

describe('entryRows on a day early in the month', () => {
  it('this month before its due date is unpaid, not ahead; only later months are ahead', () => {
    const today = '2026-11-03';
    const nov: PreviewItem = { due_id: 'd-2026-11', period: '2026-11', kind: 'monthly', due_date: '2026-11-20', ahead: true, amount_paisa: '2000000', outstanding_paisa: '2000000' };
    const { rows } = entryRows({ items: [nov], credit_paisa: '0', monthly: { period: '2026-11', amount_paisa: '2000000' } }, 0n, today);
    expect(rows[0]).toMatchObject({ period: '2026-11', status: 'unpaid' });
    expect(rows.slice(1).every((r) => r.status === 'advance' && (r.period ?? '') > '2026-11')).toBe(true);
  });
});
