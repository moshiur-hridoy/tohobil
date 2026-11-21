import type pg from 'pg';
import { formatBDT, type Clock } from '@barakah/shared';
import { audit } from '../lib/audit';
import { decodeCursor, encodeCursor, tsKey } from '../lib/cursor';
import { paisaOut, toBigInt } from '../lib/money';
import { getRule, rulePaisa } from '../lib/rules';
import { inTransaction, type Db } from '../lib/tx';
import { renderNotification } from '../notifications/catalog';
import { fmtMonth } from '../notifications/service';

export interface FineDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface AppliedFine {
  fine_id: string;
  member_id: string;
  member_code: string;
  due_id: string;
  period: string;
  amount_paisa: bigint;
}

/**
 * Fine every monthly due whose date is before `cutoff` and that is still not fully paid (spec 5.5),
 * optionally for one member only. One fine per due, never compounding.
 *
 * A due is skipped while the member has a payment waiting for the cashier that was sent and recorded
 * within that month by the due date (ASSUMPTIONS 130): the money may have arrived on time, so the
 * cashier's decision settles it. Confirming or rejecting that payment runs `applyFinesForMember`.
 */
async function insertLateFines(
  tx: Db,
  cutoff: string,
  only: { memberId: string; scope: CatchUpScope } | null,
): Promise<AppliedFine[]> {
  const fineAmount = await rulePaisa(tx, 'fine_per_share_paisa', cutoff);
  const res = await tx.query(
    `SELECT d.id AS due_id, d.member_id, d.period, m.code, shares_on(d.member_id, d.due_date) AS shares
     FROM dues d
     JOIN members m ON m.id = d.member_id
     WHERE d.kind = 'monthly'
       AND d.due_date < $1::date
       AND ($2::uuid IS NULL OR d.member_id = $2)
       AND ($3::date IS NULL OR $3::date BETWEEN (d.period || '-01')::date AND d.due_date)
       AND ($4::uuid[] IS NULL OR d.id = ANY($4::uuid[]))
       AND m.status IN ('active','warning')
       AND NOT EXISTS (
         SELECT 1 FROM fines f
         WHERE f.due_id = d.id AND f.kind = 'late_payment'
       )
       AND d.amount_paisa > COALESCE(
         (SELECT SUM(amount_paisa) FROM payment_allocations WHERE due_id = d.id),
         0
       )
       AND NOT EXISTS (
         SELECT 1 FROM payments p
         WHERE p.member_id = d.member_id AND p.status = 'pending' AND p.purpose = 'dues'
           AND (GREATEST(p.paid_at, p.submitted_at) AT TIME ZONE 'Asia/Dhaka')::date
               BETWEEN (d.period || '-01')::date AND d.due_date
       )`,
    [
      cutoff,
      only?.memberId ?? null,
      only && 'sentOn' in only.scope ? only.scope.sentOn : null,
      only && 'dueIds' in only.scope ? only.scope.dueIds : null,
    ],
  );
  const rows = res.rows as Array<{
    due_id: string;
    member_id: string;
    period: string;
    code: string;
    shares: number;
  }>;
  const created: AppliedFine[] = [];
  for (const row of rows) {
    const amount = BigInt(row.shares) * fineAmount;
    if (amount <= 0n) continue;
    const insert = await tx.query(
      `INSERT INTO fines (due_id, member_id, amount_paisa, reason)
       VALUES ($1, $2, $3::bigint, 'late_payment')
       ON CONFLICT (due_id) WHERE due_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [row.due_id, row.member_id, amount.toString()],
    );
    const fineId = (insert.rows[0] as { id: string } | undefined)?.id;
    if (fineId) {
      created.push({
        fine_id: fineId,
        member_id: row.member_id,
        member_code: row.code,
        due_id: row.due_id,
        period: row.period,
        amount_paisa: amount,
      });
    }
  }
  return created;
}

const summary = (created: AppliedFine[]) => ({
  count: created.length,
  total_paisa: created.reduce((s, c) => s + c.amount_paisa, 0n).toString(),
});

/**
 * Apply fines for a specific business date (spec 5.5). Idempotent: only one fine per due.
 * The job calls this on `fine_day` of every month. Fines never compound and only late-payment
 * dues produce fines; absence fines come from meetings (Phase 3).
 */
export async function applyFines(deps: FineDeps, asOf?: string): Promise<AppliedFine[]> {
  const today = asOf ?? deps.clock.todayDhaka();
  return inTransaction(deps.pool, async (tx) => {
    const created = await insertLateFines(tx, today, null);
    if (created.length > 0) {
      await audit(tx, {
        actor: null,
        action: 'fines.apply',
        entityType: 'date',
        entityId: today,
        after: summary(created),
      });
    }
    return created;
  });
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The latest day on or before `today` (YYYY-MM-DD) on which the fine job ran. */
export function lastFineRun(today: string, fineDay: number): string {
  let [year, month] = today.split('-').map(Number) as [number, number];
  if (Number(today.slice(8, 10)) < fineDay) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return `${year}-${pad2(month)}-${pad2(fineDay)}`;
}

/**
 * Which dues a catch-up may fine: those a payment sent on `sentOn` (the later of the day paid and the
 * day recorded) made the fine job wait for, or the dues a reversed payment had paid.
 */
export type CatchUpScope = { sentOn: string } | { dueIds: string[] };

/**
 * Catch up one member after the cashier settles a payment the fine job had waited for, or reverses
 * one (ASSUMPTIONS 130): the fines that job would have made at its last run, for the dues in `scope`
 * still not fully paid. Runs in the caller's transaction.
 */
export async function applyFinesForMember(
  tx: Db,
  clock: Clock,
  memberId: string,
  scope: CatchUpScope,
): Promise<AppliedFine[]> {
  const today = clock.todayDhaka();
  const rule = await getRule(tx, 'fine_day', today);
  const fineDay = Number(rule?.value);
  const cutoff = lastFineRun(today, Number.isInteger(fineDay) && fineDay >= 1 && fineDay <= 28 ? fineDay : 21);
  const created = await insertLateFines(tx, cutoff, { memberId, scope });
  if (created.length > 0) {
    await audit(tx, {
      actor: null,
      action: 'fines.apply',
      entityType: 'member',
      entityId: memberId,
      after: { ...summary(created), as_of: cutoff },
    });
  }
  return created;
}

export interface OnTimeFine {
  fine_id: string;
  due_id: string;
  period: string;
  amount_paisa: bigint;
}

/**
 * Late fines that money counted as arrived on `onTime` (YYYY-MM-DD) could prove wrong: unpaid,
 * not waived or cancelled, on a monthly due whose date is on or after that day, and no money that
 * arrived after the due date has paid any of it (then the due was late anyway). The caller cancels
 * one only if its payment then pays the due in full.
 */
export async function onTimeFineCandidates(db: Db, memberId: string, onTime: string): Promise<OnTimeFine[]> {
  const res = await db.query(
    `SELECT f.id AS fine_id, f.due_id, d.period, f.amount_paisa
     FROM fines f
     JOIN dues d ON d.id = f.due_id
     JOIN v_fine_status s ON s.fine_id = f.id
     WHERE f.member_id = $1 AND f.kind = 'late_payment' AND d.kind = 'monthly'
       AND d.due_date >= $2::date
       AND f.waived_at IS NULL AND NOT s.cancelled AND s.allocated_paisa = 0
       AND NOT EXISTS (
         SELECT 1 FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id
         WHERE pa.due_id = d.id AND pa.amount_paisa > 0 AND p.status = 'confirmed'
           AND (p.paid_at AT TIME ZONE 'Asia/Dhaka')::date > d.due_date
       )
     ORDER BY d.due_date`,
    [memberId, onTime],
  );
  return (res.rows as Array<{ fine_id: string; due_id: string; period: string; amount_paisa: unknown }>).map((r) => ({
    fine_id: r.fine_id,
    due_id: r.due_id,
    period: r.period,
    amount_paisa: toBigInt(r.amount_paisa),
  }));
}

/**
 * Record that `fines` were cancelled because `paymentId` paid their dues on time (ASSUMPTIONS 130).
 * Insert-only; audited; the member is told. Runs in the caller's transaction.
 */
export async function cancelFines(
  tx: Db,
  input: {
    fines: readonly OnTimeFine[];
    paymentId: string;
    memberId: string;
    paidOn: string;
    reason: string | null;
    actor: { id: string; device_id?: string | undefined };
    ip?: string | undefined;
  },
): Promise<void> {
  if (input.fines.length === 0) return;
  for (const f of input.fines) {
    await tx.query(
      `INSERT INTO fine_cancellations (fine_id, payment_id, paid_on, reason, cancelled_by)
       VALUES ($1, $2, $3::date, $4, $5)`,
      [f.fine_id, input.paymentId, input.paidOn, input.reason, input.actor.id],
    );
  }
  const total = input.fines.reduce((s, f) => s + f.amount_paisa, 0n);
  await audit(tx, {
    actor: input.actor.id,
    action: 'fine.cancel',
    entityType: 'payment',
    entityId: input.paymentId,
    after: {
      member_id: input.memberId,
      paid_on: input.paidOn,
      reason: input.reason,
      fines: input.fines.map((f) => ({ fine_id: f.fine_id, period: f.period, amount_paisa: f.amount_paisa.toString() })),
      total_paisa: total.toString(),
    },
    ip: input.ip,
    deviceId: input.actor.device_id,
  });
  const vars = {
    month: input.fines.map((f) => fmtMonth(f.period)).join(', '),
    amount: formatBDT(total, { digits: 'bn' }),
  };
  await tx.query(
    `INSERT INTO notifications (member_id, template, channel, payload, dedupe_key)
     VALUES ($1, 'fine_cancelled', 'push', $2::jsonb, $3)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.memberId,
      JSON.stringify({ ...vars, payment_id: input.paymentId, _body: renderNotification('fine_cancelled', vars).body }),
      `fine_cancelled:${input.paymentId}`,
    ],
  );
}

/**
 * `GET /fines/cancellations` (cashier, auditor): every fine cancelled by an on-time payment, newest
 * first, with the cashier's reason when the payment was entered with an earlier date. `in_force` is
 * false once that payment was reversed or the due reopened (the fine is owed again).
 */
export async function listFineCancellations(
  db: Db,
  q: { limit: number; cursor?: string | undefined },
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const cursor = decodeCursor(q.cursor, 2); // [created_at, id]
  const res = await db.query(
    `SELECT c.id, c.fine_id, c.payment_id, c.paid_on::text AS paid_on, c.reason, c.created_at,
            ${tsKey('c.created_at')} AS created_key,
            m.code AS member_code, m.full_name AS member_name, d.period, d.due_date::text AS due_date,
            f.amount_paisa, p.amount_paisa AS payment_amount_paisa, p.method, p.source,
            (p.submitted_at AT TIME ZONE 'Asia/Dhaka')::date::text AS recorded_on,
            cm.code AS cancelled_by_code, s.cancelled AS in_force
     FROM fine_cancellations c
     JOIN fines f ON f.id = c.fine_id
     JOIN v_fine_status s ON s.fine_id = f.id
     JOIN dues d ON d.id = f.due_id
     JOIN members m ON m.id = f.member_id
     JOIN payments p ON p.id = c.payment_id
     LEFT JOIN users u ON u.id = c.cancelled_by
     LEFT JOIN members cm ON cm.id = u.member_id
     WHERE ($1::timestamptz IS NULL OR (c.created_at, c.id) < ($1::timestamptz, $2::uuid))
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $3`,
    [cursor?.[0] ?? null, cursor?.[1] ?? null, q.limit + 1],
  );
  const rows = res.rows as Array<Record<string, unknown> & { id: string; created_key: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ created_key: _key, ...r }) => ({
      ...r,
      amount_paisa: paisaOut(r.amount_paisa),
      payment_amount_paisa: paisaOut(r.payment_amount_paisa),
    })),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.created_key, last.id]) : null,
  };
}
