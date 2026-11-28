/**
 * "How much did you send?" on the member's pay page (bKash only, ASSUMPTIONS 134): taking the cash-out
 * charge out of the sent amount, and showing which dues the rest reaches. All amounts are bigint paisa.
 */

/** bKash cash-out charge: ৳18.50 per ৳1,000, as paisa per 10,000 paisa. */
const BKASH_CHARGE_PER_10000 = 185n;
/** The same rate as shown to the member: paisa charged on ৳1,000. */
export const BKASH_CHARGE_PER_THOUSAND = BKASH_CHARGE_PER_10000 * 10n;

const WHOLE = 10_000n;

/** What a member sends so that `net` reaches the fund: the amount plus the charge on it. */
export function bkashGross(net: bigint): bigint {
  return net + (net * BKASH_CHARGE_PER_10000 + WHOLE / 2n) / WHOLE;
}

/**
 * What reaches the fund out of `sent`. The charge is on the money that lands, not on the sent figure,
 * so ৳10,185 sent pays a ৳10,000 due in full: the exact reverse of `bkashGross`.
 */
export function bkashNet(sent: bigint): bigint {
  const gross = WHOLE + BKASH_CHARGE_PER_10000;
  return (sent * WHOLE * 2n + gross) / (gross * 2n);
}

/**
 * The order a confirmed payment pays in (`planDefaultAllocation`): dues already due, then fines, then
 * dues not yet due; months ahead with no due yet come last (their money waits as credit).
 */
export const FILL_ORDER = { due: 0, fine: 1, notYetDue: 2, noDueYet: 3 } as const;

export interface FillPart {
  /** The row on screen this part belongs to: a month, or a fine on its own. */
  key: string;
  amount: bigint;
  order: (typeof FILL_ORDER)[keyof typeof FILL_ORDER];
}

/**
 * Spreads `amount` over the parts in payment order; returns what lands on each row, how much of it
 * pays fines, and what no row takes.
 */
export function fillRows(parts: readonly FillPart[], amount: bigint): { covered: Map<string, bigint>; fines: bigint; leftover: bigint } {
  const covered = new Map<string, bigint>();
  let fines = 0n;
  let left = amount;
  // A stable sort: within one order the parts keep the sequence given (oldest first).
  for (const p of [...parts].sort((a, b) => a.order - b.order)) {
    const take = p.amount < left ? p.amount : left;
    if (take <= 0n) continue;
    covered.set(p.key, (covered.get(p.key) ?? 0n) + take);
    if (p.order === FILL_ORDER.fine) fines += take;
    left -= take;
  }
  return { covered, fines, leftover: left };
}
