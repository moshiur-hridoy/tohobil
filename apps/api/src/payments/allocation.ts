import { badRequest } from '../lib/errors';

/**
 * Allocation of one payment (spec 5.4). Pure: the service loads what the member still owes and
 * persists the result.
 *
 * Default order `oldest_principal_then_fines`: dues by `due_date` (then id) first, then unwaived fines
 * by `created_at`. Whatever is left is the member's credit (still capital, spent on the next dues).
 *
 * A due whose date has not come yet (`ahead`) is not owed yet, so it is paid last, after the fines:
 * money beyond what is owed clears the member's fines before it pays a coming month in advance.
 */

export interface Outstanding {
  id: string;
  outstanding: bigint;
  /** The due date is still in the future; paid only after everything already owed. */
  ahead?: boolean;
}

export interface AllocationLine {
  due_id?: string;
  fine_id?: string;
  amount: bigint;
}

export interface AllocationPlan {
  lines: AllocationLine[];
  /** Total allocated to dues: member capital. */
  principal: bigint;
  /** Total allocated to fines: charity money (18.2). */
  fine: bigint;
  /** Remainder: member credit, still capital. */
  credit: bigint;
}

function summarize(amount: bigint, lines: AllocationLine[]): AllocationPlan {
  let principal = 0n;
  let fine = 0n;
  for (const l of lines) {
    if (l.due_id !== undefined) principal += l.amount;
    else fine += l.amount;
  }
  return { lines, principal, fine, credit: amount - principal - fine };
}

/** `dues` and `fines` must already be in payment order (oldest first), with only open items. */
export function planDefaultAllocation(
  amount: bigint,
  dues: readonly Outstanding[],
  fines: readonly Outstanding[],
): AllocationPlan {
  let left = amount;
  const lines: AllocationLine[] = [];
  const pay = (items: readonly Outstanding[], key: 'due_id' | 'fine_id') => {
    for (const i of items) {
      if (left === 0n) break;
      const take = i.outstanding < left ? i.outstanding : left;
      if (take > 0n) lines.push({ [key]: i.id, amount: take });
      left -= take;
    }
  };
  pay(dues.filter((d) => !d.ahead), 'due_id');
  pay(fines, 'fine_id');
  pay(dues.filter((d) => d.ahead), 'due_id');
  return summarize(amount, lines);
}

/**
 * Validate a cashier's manual list against what is open and the payment amount. Lines for the same
 * target are merged first. The unallocated rest becomes credit.
 */
export function planManualAllocation(
  amount: bigint,
  requested: ReadonlyArray<{ due_id?: string | undefined; fine_id?: string | undefined; amount_paisa: bigint }>,
  dues: readonly Outstanding[],
  fines: readonly Outstanding[],
): AllocationPlan {
  const open = new Map<string, bigint>();
  for (const d of dues) open.set(`d:${d.id}`, d.outstanding);
  for (const f of fines) open.set(`f:${f.id}`, f.outstanding);

  const merged = new Map<string, bigint>();
  for (const r of requested) {
    const key = r.due_id !== undefined ? `d:${r.due_id}` : `f:${r.fine_id as string}`;
    if (!open.has(key)) {
      throw badRequest(
        'payment.allocation_invalid',
        'An allocation points at a due or fine that is not open for this member',
      );
    }
    merged.set(key, (merged.get(key) ?? 0n) + r.amount_paisa);
  }

  let total = 0n;
  const lines: AllocationLine[] = [];
  for (const [key, value] of merged) {
    if (value > (open.get(key) as bigint)) {
      throw badRequest(
        'payment.allocation_exceeds_outstanding',
        'An allocation is larger than what is still owed',
      );
    }
    total += value;
    const id = key.slice(2);
    lines.push(key.startsWith('d:') ? { due_id: id, amount: value } : { fine_id: id, amount: value });
  }
  if (total > amount) {
    throw badRequest('payment.allocation_exceeds_amount', 'Allocations exceed the payment amount');
  }
  return summarize(amount, lines);
}
