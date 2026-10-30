import { addMonths } from '@barakah/shared';

/** One open due or fine from `GET /payments/entry-preview`, already in the order a payment pays them. */
export interface PreviewItem {
  due_id?: string;
  fine_id?: string;
  period: string | null;
  kind: string;
  due_date: string | null;
  ahead: boolean;
  amount_paisa: string;
  outstanding_paisa: string;
}

export interface EntryPreview {
  items: PreviewItem[];
  credit_paisa: string;
  monthly: { period: string; amount_paisa: string } | null;
}

export interface EntryRow {
  key: string;
  period: string | null;
  kind: string;
  dueDate: string | null;
  status: 'overdue' | 'unpaid' | 'partial' | 'advance';
  /** What this row still asks for. */
  need: bigint;
  /** A month ahead with no due yet: the money waits as credit until the dues job creates it. */
  projected: boolean;
  /** How much of the typed amount lands here. */
  covered: bigint;
}

/** How many months ahead the sheet offers, as on the member's pay page (ASSUMPTIONS 99). */
export const MAX_AHEAD = 12;
/** Unticked months shown after the last one the amount reaches. */
const SHOWN_AHEAD = 2;

/**
 * The rows the cashier sees, filled top down with `amount` the way the server allocates: open dues
 * and fines in the server's order, then the months ahead priced at the latest monthly due. Credit the
 * member already holds is spent on those months first (that is what the dues job does), so they ask
 * only for what that credit does not cover. Whatever is left after the last month is plain credit.
 */
export function entryRows(preview: EntryPreview, amount: bigint, today: string): { rows: EntryRow[]; leftover: bigint } {
  const currentPeriod = today.slice(0, 7);
  const rows: EntryRow[] = preview.items.map((i) => {
    const need = BigInt(i.outstanding_paisa);
    const late = i.kind === 'fine' || (i.due_date !== null && i.due_date < today);
    return {
      key: i.due_id ?? (i.fine_id as string),
      period: i.period,
      kind: i.kind,
      dueDate: i.due_date,
      status: late ? 'overdue' : i.ahead || (i.period ?? '') > currentPeriod ? 'advance' : need < BigInt(i.amount_paisa) ? 'partial' : 'unpaid',
      need,
      projected: false,
      covered: 0n,
    };
  });

  if (preview.monthly) {
    const price = BigInt(preview.monthly.amount_paisa);
    const from = [preview.monthly.period, currentPeriod].sort().at(-1) as string;
    let held = BigInt(preview.credit_paisa);
    for (let i = 1; i <= MAX_AHEAD && price > 0n; i++) {
      const take = held < price ? held : price;
      held -= take;
      if (take === price) continue;
      const period = addMonths(from, i);
      rows.push({ key: `ahead-${period}`, period, kind: 'monthly', dueDate: null, status: 'advance', need: price - take, projected: true, covered: 0n });
    }
  }

  let left = amount;
  for (const r of rows) {
    r.covered = left < r.need ? left : r.need;
    left -= r.covered;
  }

  // Every open item stays listed; months ahead only up to the amount's reach plus a couple more.
  const lastReached = rows.reduce((at, r, i) => (r.covered > 0n || !r.projected ? i : at), -1);
  const shown = rows.filter((r, i) => !r.projected || i <= lastReached + SHOWN_AHEAD);
  return { rows: shown, leftover: left };
}

/**
 * The amount that makes the tapped row the last one paid in full: tapping a row that is already
 * fully paid stops just before it instead, like unticking a month on the pay page.
 */
export function amountForTap(rows: readonly EntryRow[], index: number): bigint {
  const before = rows.slice(0, index).reduce((s, r) => s + r.need, 0n);
  const row = rows[index] as EntryRow;
  return row.covered === row.need ? before : before + row.need;
}
