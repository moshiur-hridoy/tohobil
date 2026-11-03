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
 * Each month's fine sits right under that month, so "July" and "July's fine" are paid together
 * (owner request). A fine whose month is already paid stays where the server put it.
 */
function besideTheirMonth(items: readonly PreviewItem[]): PreviewItem[] {
  const fines = items.filter((i) => i.kind === 'fine');
  const placed = new Set<PreviewItem>();
  const out: PreviewItem[] = [];
  const hasMonth = (f: PreviewItem) => items.some((i) => i.kind !== 'fine' && i.period === f.period);
  for (const i of items) {
    if (i.kind === 'fine' && hasMonth(i)) continue;
    out.push(i);
    if (i.kind === 'fine') continue;
    for (const f of fines) {
      if (f.period === i.period && !placed.has(f)) {
        out.push(f);
        placed.add(f);
      }
    }
  }
  return out;
}

/**
 * The rows the cashier sees, in the order the money fills them: open dues with each month's fine
 * right under it, then the months ahead priced at the latest monthly due. Credit the member already
 * holds is spent on those months first (that is what the dues job does), so they ask only for what
 * that credit does not cover.
 *
 * Without `picked` the typed amount fills the rows top down. With `picked` (the cashier ticked rows
 * one by one) only those rows are paid, in full. Whatever is left is plain credit. The sheet sends
 * the result as a manual allocation (`allocationsFor`), so the server pays exactly what is shown.
 */
export function entryRows(
  preview: EntryPreview,
  amount: bigint,
  today: string,
  picked: ReadonlySet<string> | null = null,
): { rows: EntryRow[]; leftover: bigint } {
  const currentPeriod = today.slice(0, 7);
  const rows: EntryRow[] = besideTheirMonth(preview.items).map((i) => {
    const need = BigInt(i.outstanding_paisa);
    const late = i.kind === 'fine' || (i.due_date !== null && i.due_date < today);
    return {
      key: i.due_id ?? (i.fine_id as string),
      period: i.period,
      kind: i.kind,
      dueDate: i.due_date,
      // Ahead means a month that has not begun; this month before its due date is simply on time.
      status: late ? 'overdue' : (i.period ?? '') > currentPeriod ? 'advance' : need < BigInt(i.amount_paisa) ? 'partial' : 'unpaid',
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
    const want = picked ? (picked.has(r.key) ? r.need : 0n) : r.need;
    r.covered = left < want ? left : want;
    left -= r.covered;
  }

  // Every open item stays listed; months ahead only up to the amount's reach plus a couple more.
  const lastReached = rows.reduce((at, r, i) => (r.covered > 0n || !r.projected ? i : at), -1);
  const shown = rows.filter((r, i) => !r.projected || i <= lastReached + SHOWN_AHEAD);
  return { rows: shown, leftover: left };
}

/**
 * Ticking or unticking one row. The first tap starts from the rows the typed amount already pays in
 * full. Open dues and fines are picked one by one; months ahead have no due yet (their money waits
 * as credit and the dues job spends it in month order), so they stay a run from the first one:
 * ticking one ticks those before it, unticking one unticks those after it.
 */
export function togglePick(rows: readonly EntryRow[], picked: ReadonlySet<string> | null, key: string): Set<string> {
  const next = new Set(picked ?? rows.filter((r) => r.need > 0n && r.covered === r.need).map((r) => r.key));
  const ahead = rows.filter((r) => r.projected);
  const at = ahead.findIndex((r) => r.key === key);
  if (at === -1) {
    if (next.has(key)) next.delete(key);
    else next.add(key);
  } else if (next.has(key)) {
    for (const r of ahead.slice(at)) next.delete(r.key);
  } else {
    for (const r of ahead.slice(0, at + 1)) next.add(r.key);
  }
  return next;
}

/** What the picked rows cost together: the amount the sheet sets after a tap. */
export function pickedTotal(rows: readonly EntryRow[], picked: ReadonlySet<string>): bigint {
  return rows.reduce((s, r) => s + (picked.has(r.key) ? r.need : 0n), 0n);
}

/** The manual allocation for what the rows show: open dues and fines only (months ahead are credit). */
export function allocationsFor(rows: readonly EntryRow[]): Array<{ due_id?: string; fine_id?: string; amount_paisa: string }> {
  return rows
    .filter((r) => !r.projected && r.covered > 0n)
    .map((r) => ({ ...(r.kind === 'fine' ? { fine_id: r.key } : { due_id: r.key }), amount_paisa: r.covered.toString() }));
}
