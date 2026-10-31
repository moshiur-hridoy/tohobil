import { addMonths } from '@barakah/shared';

interface AdvanceDue {
  period: string;
  kind: string;
  amount_paisa: string;
  outstanding_paisa: string;
  due_date: string;
}

export interface Advance {
  /** Whole months paid before they are due: months already paid ahead, then what the credit buys. */
  months: number;
  /** The last month those cover. */
  through: string | null;
  /** Credit left over that does not make a whole month. */
  extra: bigint;
}

/**
 * How far ahead a member has paid, for the home card. Monthly dues whose date has not come yet and
 * are fully paid count first, in month order; if none of those is still open, the credit the member
 * holds is turned into whole months at the latest monthly price (the dues job spends it that way,
 * ASSUMPTIONS 99).
 */
export function advanceOf(dues: readonly AdvanceDue[], creditPaisa: string, today: string): Advance {
  const monthly = dues.filter((d) => d.kind === 'monthly').sort((a, b) => a.period.localeCompare(b.period));
  let months = 0;
  let through: string | null = null;
  for (const d of monthly.filter((m) => m.due_date > today)) {
    // a month ahead still open gets the money first, so the credit is not counted beyond it
    if (BigInt(d.outstanding_paisa) > 0n) return { months, through, extra: 0n };
    months++;
    through = d.period;
  }
  const credit = BigInt(creditPaisa);
  const last = monthly.at(-1);
  const price = last ? BigInt(last.amount_paisa) : 0n;
  if (!last || price <= 0n) return { months, through, extra: credit };
  const bought = Number(credit / price);
  if (bought > 0) through = addMonths(last.period, bought);
  return { months: months + bought, through, extra: credit % price };
}

/**
 * The months after `lastPeriod` (no due yet) a member can still pay ahead, priced at `price`. The
 * advance credit they already hold pays the first of these (the dues job spends it in month order),
 * so a month it fully covers is left out and a part-covered one asks only for the rest. `count`
 * months still to pay are returned.
 */
export function monthsAhead(lastPeriod: string, price: bigint, creditPaisa: string, count: number): Array<{ period: string; need: bigint }> {
  const out: Array<{ period: string; need: bigint }> = [];
  let held = BigInt(creditPaisa);
  for (let i = 1; out.length < count && price > 0n; i++) {
    const take = held < price ? held : price;
    held -= take;
    if (take < price) out.push({ period: addMonths(lastPeriod, i), need: price - take });
  }
  return out;
}
