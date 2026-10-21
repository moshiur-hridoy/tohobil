import type pg from 'pg';
import type { Logger } from 'pino';
import {
  toDhakaDate,
  type CashierEntry,
  type Clock,
  type ParseSms,
  type PaymentConfirm,
  type PaymentPurpose,
  type PaymentReject,
  type PaymentSubmit,
  type PaymentsQuery,
  type ApprovalsQuery,
} from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { activateProspectiveMember } from '../members/entry';
import { LEDGER_REF, postEntries, reverseReference } from '../ledger/service';
import { paymentPostings } from '../ledger/postings';
import { audit } from '../lib/audit';
import { decodeCursor, encodeCursor, tsKey } from '../lib/cursor';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { paisaOut, toBigInt } from '../lib/money';
import { ruleString } from '../lib/rules';
import { inTransaction, type Db } from '../lib/tx';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import {
  planDefaultAllocation,
  planManualAllocation,
  type AllocationPlan,
  type Outstanding,
} from './allocation';
import { parsePaymentSms } from './sms-parser';

export interface PaymentDeps {
  pool: pg.Pool;
  clock: Clock;
  log: Logger;
  pushSender: PushSender;
  smsProvider: SmsProvider;
}

export interface ClientCtx {
  ip?: string | undefined;
}

/** Purposes the allocation and posting rules cover; settlement shortfalls are not paid through here. */
const SUPPORTED_PURPOSES: readonly PaymentPurpose[] = ['dues', 'entry', 'levy', 'special'];
const PURPOSE_DUE_KINDS: Record<string, string[]> = {
  dues: ['monthly', 'start_boost'],
  entry: ['entry'],
  levy: ['levy'],
  special: ['special'],
};

const FUTURE_SLACK_MS = 5 * 60_000;
const SMS_MATCH_WINDOW_DAYS = 3;

const isPrivileged = (u: AuthUser): boolean =>
  u.roles.includes('cashier') || u.roles.includes('auditor');

function checkPurpose(purpose: PaymentPurpose): void {
  if (!SUPPORTED_PURPOSES.includes(purpose)) {
    throw badRequest(
      'payment.purpose_unsupported',
      `Payments for "${purpose}" are not available yet`,
    );
  }
}

function checkNotFuture(deps: PaymentDeps, paidAt: Date): void {
  if (paidAt.getTime() > deps.clock.now().getTime() + FUTURE_SLACK_MS) {
    throw badRequest('payment.paid_in_future', 'The payment date cannot be in the future');
  }
}

// ---- creation -------------------------------------------------------------------------------

interface NewPayment {
  memberId: string;
  amount: bigint;
  method: string;
  purpose: PaymentPurpose;
  trxId: string | null;
  paidAt: Date;
  source: 'member_submitted' | 'cashier_entry' | 'sms_match';
  forPeriods: string[] | null;
  proofFileId: string | null;
  rawSms: string | null;
  note: string | null;
  submittedBy: string;
}

async function insertPayment(tx: pg.PoolClient, p: NewPayment): Promise<string> {
  const res = await tx.query(
    `INSERT INTO payments (member_id, amount_paisa, method, purpose, trx_id, paid_at, source,
                           for_periods, proof_file_id, raw_sms, note, submitted_by)
     VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12)
     RETURNING id`,
    [
      p.memberId,
      p.amount.toString(),
      p.method,
      p.purpose,
      p.trxId,
      p.paidAt,
      p.source,
      p.forPeriods,
      p.proofFileId,
      p.rawSms,
      p.note,
      p.submittedBy,
    ],
  );
  return (res.rows[0] as { id: string }).id;
}

/** 409 with a pointer to the payment that already holds this TrxID. */
async function rethrowDuplicate(pool: pg.Pool, err: unknown, trxId: string | null): Promise<never> {
  if ((err as { constraint?: string }).constraint === 'payments_trx_active' && trxId) {
    const res = await pool.query(
      `SELECT id, status FROM payments
       WHERE upper(trim(trx_id)) = upper(trim($1)) AND status IN ('pending','confirmed')`,
      [trxId],
    );
    const existing = res.rows[0] as { id: string; status: string } | undefined;
    throw conflict('payment.duplicate_trx', 'This TrxID has already been submitted', {
      existing_payment_id: existing?.id ?? null,
      existing_status: existing?.status ?? null,
    });
  }
  throw err;
}

export interface CreatedPayment {
  id: string;
  status: 'pending';
}

/**
 * `POST /payments`: a member says "I have sent money". The payer is always the caller. The payment
 * waits as `pending`; nothing touches the ledger, balances or NAV until the cashier confirms (5.4).
 */
export async function submitPayment(
  deps: PaymentDeps,
  user: AuthUser,
  input: PaymentSubmit,
  ctx: ClientCtx,
): Promise<CreatedPayment> {
  checkPurpose(input.purpose);
  const paidAt = input.paid_at ? new Date(input.paid_at) : deps.clock.now();
  checkNotFuture(deps, paidAt);
  const trxId = input.trx_id?.trim() || null;

  try {
    return await inTransaction(deps.pool, async (tx) => {
      if (input.proof_file_id) {
        const file = await tx.query(`SELECT mime, created_by FROM files WHERE id = $1`, [
          input.proof_file_id,
        ]);
        const row = file.rows[0] as { mime: string; created_by: string | null } | undefined;
        // Somebody else's upload is the same as a missing one: a proof must be your own file.
        if (!row || row.created_by !== user.id) throw notFound('file.not_found', 'File not found');
      }
      const id = await insertPayment(tx, {
        memberId: user.member_id,
        amount: input.amount_paisa,
        method: input.method,
        purpose: input.purpose,
        trxId,
        paidAt,
        source: 'member_submitted',
        forPeriods: input.for_periods ?? null,
        proofFileId: input.proof_file_id ?? null,
        rawSms: null,
        note: input.note ?? null,
        submittedBy: user.id,
      });
      await audit(tx, {
        actor: user.id,
        action: 'payment.submit',
        entityType: 'payment',
        entityId: id,
        after: {
          amount_paisa: input.amount_paisa.toString(),
          method: input.method,
          purpose: input.purpose,
          trx_id: trxId,
          paid_at: paidAt.toISOString(),
          has_proof: !!input.proof_file_id,
        },
        ip: ctx.ip,
        deviceId: user.device_id,
      });
      return { id, status: 'pending' as const };
    });
  } catch (err) {
    return rethrowDuplicate(deps.pool, err, trxId);
  }
}

// ---- allocation and confirmation ------------------------------------------------------------

async function openItems(
  db: Db,
  memberId: string,
  purpose: PaymentPurpose,
): Promise<{ dues: Outstanding[]; fines: Outstanding[] }> {
  const dues = await db.query(
    `SELECT due_id AS id, outstanding_paisa FROM v_due_status
     WHERE member_id = $1 AND outstanding_paisa > 0 AND kind = ANY($2::text[])
     ORDER BY due_date, due_id`,
    [memberId, PURPOSE_DUE_KINDS[purpose] ?? []],
  );
  // Fines are paid together with ordinary dues only.
  const fines =
    purpose === 'dues'
      ? await db.query(
          `SELECT s.fine_id AS id, s.outstanding_paisa FROM v_fine_status s
           JOIN fines f ON f.id = s.fine_id
           WHERE s.member_id = $1 AND s.outstanding_paisa > 0
           ORDER BY f.created_at, f.id`,
          [memberId],
        )
      : { rows: [] };
  const map = (r: unknown): Outstanding => {
    const row = r as { id: string; outstanding_paisa: unknown };
    return { id: row.id, outstanding: toBigInt(row.outstanding_paisa) };
  };
  return { dues: dues.rows.map(map), fines: fines.rows.map(map) };
}

function planFor(
  amount: bigint,
  manual: PaymentConfirm['allocations'],
  items: { dues: Outstanding[]; fines: Outstanding[] },
): AllocationPlan {
  return manual
    ? planManualAllocation(amount, manual, items.dues, items.fines)
    : planDefaultAllocation(amount, items.dues, items.fines);
}

const planOut = (plan: AllocationPlan) => ({
  principal_paisa: plan.principal.toString(),
  fine_paisa: plan.fine.toString(),
  credit_paisa: plan.credit.toString(),
  lines: plan.lines.map((l) => ({
    ...(l.due_id !== undefined ? { due_id: l.due_id } : { fine_id: l.fine_id as string }),
    amount_paisa: l.amount.toString(),
  })),
});

type PlanOut = ReturnType<typeof planOut>;

export interface ConfirmedPayment {
  id: string;
  status: 'confirmed';
  allocation: PlanOut;
}

async function isPeriodLocked(tx: pg.PoolClient, date: string): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM periods WHERE period = $1 AND locked_at IS NOT NULL`,
    [date.slice(0, 7)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Steps (a) to (e) of 5.4 in the caller's transaction: lock, allocate, post, mark confirmed, audit
 * and queue the member's notification. Everything commits or nothing does.
 */
async function confirmInTx(
  tx: pg.PoolClient,
  deps: PaymentDeps,
  actor: AuthUser,
  paymentId: string,
  manual: PaymentConfirm['allocations'],
  ctx: ClientCtx,
  action: 'payment.confirm' | 'payment.cashier_entry',
): Promise<ConfirmedPayment> {
  const res = await tx.query(
    `SELECT id, member_id, amount_paisa, method, purpose, status, paid_at
     FROM payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  const p = res.rows[0] as
    | {
        id: string;
        member_id: string;
        amount_paisa: unknown;
        method: string;
        purpose: PaymentPurpose;
        status: string;
        paid_at: Date;
      }
    | undefined;
  if (!p) throw notFound('payment.not_found', 'Payment not found');
  if (p.status !== 'pending') {
    throw conflict('payment.not_pending', `This payment is already ${p.status}`);
  }

  // Two payments of one member must not be allocated against the same open dues at once.
  await tx.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [p.member_id]);

  const order = await ruleString(tx, 'allocation_order', deps.clock.todayDhaka());
  if (order !== 'oldest_principal_then_fines') {
    // The only strategy built; guessing another order would misapply someone's money.
    throw new AppError(500, 'rule.invalid', `Unsupported allocation_order "${order}"`);
  }

  const amount = toBigInt(p.amount_paisa);
  const plan = planFor(amount, manual, await openItems(tx, p.member_id, p.purpose));
  const now = deps.clock.now();

  // The database only lets confirmed payments carry allocations, so mark it confirmed first.
  await tx.query(
    `UPDATE payments SET status = 'confirmed', confirmed_at = $2, confirmed_by = $3,
                         unallocated_paisa = $4::bigint
     WHERE id = $1`,
    [p.id, now, actor.id, plan.credit.toString()],
  );

  for (const line of plan.lines) {
    await tx.query(
      `INSERT INTO payment_allocations (payment_id, due_id, fine_id, amount_paisa)
       VALUES ($1, $2, $3, $4::bigint)`,
      [p.id, line.due_id ?? null, line.fine_id ?? null, line.amount.toString()],
    );
  }

  // The money arrived on paid_at; if that month is already locked it is booked today instead.
  let entryDate = toDhakaDate(new Date(p.paid_at));
  if (await isPeriodLocked(tx, entryDate)) entryDate = deps.clock.todayDhaka();
  await postEntries(
    tx,
    paymentPostings({
      entryDate,
      method: p.method as Parameters<typeof paymentPostings>[0]['method'],
      memberId: p.member_id,
      paymentId: p.id,
      principalPaisa: plan.principal,
      principalAccount: p.purpose === 'levy' ? 'LEVY_CLEARING' : 'MEMBER_CAPITAL',
      creditPaisa: plan.credit,
      finePaisa: plan.fine,
    }),
    { userId: actor.id, ip: ctx.ip, deviceId: actor.device_id },
  );

  // Spec 5.9: when the entry due is fully paid, activate the prospective member.
  if (p.purpose === 'entry') {
    const entryDueId = plan.lines.find((l) => l.due_id !== undefined)?.due_id;
    if (entryDueId) {
      const dueStatus = await tx.query(
        `SELECT outstanding_paisa FROM v_due_status WHERE due_id = $1`,
        [entryDueId],
      );
      const outstanding = toBigInt(
        (dueStatus.rows[0] as { outstanding_paisa: unknown } | undefined)?.outstanding_paisa ?? 0,
      );
      if (outstanding === 0n) {
        await activateProspectiveMember(tx, deps, p.member_id);
      }
    }
  }

  await audit(tx, {
    actor: actor.id,
    action,
    entityType: 'payment',
    entityId: p.id,
    after: {
      amount_paisa: amount.toString(),
      member_id: p.member_id,
      entry_date: entryDate,
      allocation: planOut(plan),
      // A cashier confirming their own payment is allowed (nobody else can) but visible to the auditor.
      self_confirmed: p.member_id === actor.member_id,
    },
    ip: ctx.ip,
    deviceId: actor.device_id,
  });

  await queueNotification(tx, p.member_id, 'payment_confirmed', `payment_confirmed:${p.id}`, {
    payment_id: p.id,
    amount_paisa: amount.toString(),
    // The member can object to the ledger rows of a payment someone else entered (5.4).
    objection_link: `/menu/ledger?ref_type=payment&ref_id=${p.id}`,
  });

  return { id: p.id, status: 'confirmed', allocation: planOut(plan) };
}

/** The member's inbox entry; the Phase 2 engine delivers it (push, then SMS if enabled). */
async function queueNotification(
  tx: pg.PoolClient,
  memberId: string,
  template: string,
  dedupeKey: string,
  payload: Record<string, string>,
): Promise<void> {
  await tx.query(
    `INSERT INTO notifications (member_id, template, channel, payload, dedupe_key)
     VALUES ($1, $2, 'push', $3::jsonb, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [memberId, template, JSON.stringify(payload), dedupeKey],
  );
}

/** `POST /payments/:id/confirm` (cashier, step-up). */
export async function confirmPayment(
  deps: PaymentDeps,
  actor: AuthUser,
  paymentId: string,
  body: PaymentConfirm,
  ctx: ClientCtx,
): Promise<ConfirmedPayment> {
  return inTransaction(deps.pool, (tx) =>
    confirmInTx(tx, deps, actor, paymentId, body.allocations, ctx, 'payment.confirm'),
  );
}

/**
 * `POST /payments/cashier-entry` (cashier, step-up): create and confirm in one step. Comes in as
 * `sms_match` when the cashier pasted an SMS, else `cashier_entry`. The member is always notified,
 * which is the second pair of eyes on the cashier's own entries.
 */
export async function cashierEntry(
  deps: PaymentDeps,
  actor: AuthUser,
  input: CashierEntry,
  ctx: ClientCtx,
): Promise<ConfirmedPayment> {
  checkPurpose(input.purpose);
  const paidAt = new Date(input.paid_at);
  checkNotFuture(deps, paidAt);
  const trxId = input.trx_id?.trim() || null;

  try {
    return await inTransaction(deps.pool, async (tx) => {
      const member = await tx.query(`SELECT 1 FROM members WHERE id = $1`, [input.member_id]);
      if ((member.rowCount ?? 0) === 0) throw notFound('member.not_found', 'Member not found');
      const id = await insertPayment(tx, {
        memberId: input.member_id,
        amount: input.amount_paisa,
        method: input.method,
        purpose: input.purpose,
        trxId,
        paidAt,
        source: input.raw_sms ? 'sms_match' : 'cashier_entry',
        forPeriods: input.for_periods ?? null,
        proofFileId: null,
        rawSms: input.raw_sms ?? null,
        note: input.note ?? null,
        submittedBy: actor.id,
      });
      return confirmInTx(tx, deps, actor, id, input.allocations, ctx, 'payment.cashier_entry');
    });
  } catch (err) {
    return rethrowDuplicate(deps.pool, err, trxId);
  }
}

/** `POST /payments/:id/reject` (cashier, step-up). A rejected TrxID can be submitted again. */
export async function rejectPayment(
  deps: PaymentDeps,
  actor: AuthUser,
  paymentId: string,
  body: PaymentReject,
  ctx: ClientCtx,
): Promise<{ id: string; status: 'rejected' }> {
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(`SELECT member_id, status FROM payments WHERE id = $1 FOR UPDATE`, [
      paymentId,
    ]);
    const p = res.rows[0] as { member_id: string; status: string } | undefined;
    if (!p) throw notFound('payment.not_found', 'Payment not found');
    if (p.status !== 'pending') {
      throw conflict('payment.not_pending', `This payment is already ${p.status}`);
    }
    await tx.query(`UPDATE payments SET status = 'rejected', reject_reason = $2 WHERE id = $1`, [
      paymentId,
      body.reason,
    ]);
    await audit(tx, {
      actor: actor.id,
      action: 'payment.reject',
      entityType: 'payment',
      entityId: paymentId,
      after: { reason: body.reason },
      ip: ctx.ip,
      deviceId: actor.device_id,
    });
    await queueNotification(tx, p.member_id, 'payment_rejected', `payment_rejected:${paymentId}`, {
      payment_id: paymentId,
      reason: body.reason,
    });
    return { id: paymentId, status: 'rejected' as const };
  });
}

// ---- reversal and approvals -----------------------------------------------------------------

/** `POST /payments/:id/reverse-request` (cashier): opens an approval item for the auditor. */
export async function requestReversal(
  deps: PaymentDeps,
  actor: AuthUser,
  paymentId: string,
  reason: string,
  ctx: ClientCtx,
): Promise<{ approval_id: string; status: 'pending' }> {
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(`SELECT status FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const p = res.rows[0] as { status: string } | undefined;
    if (!p) throw notFound('payment.not_found', 'Payment not found');
    if (p.status !== 'confirmed') {
      throw conflict('payment.not_confirmed', 'Only a confirmed payment can be reversed');
    }
    const open = await tx.query(
      `SELECT id FROM approvals WHERE kind = 'payment_reversal' AND ref_id = $1 AND status = 'pending'`,
      [paymentId],
    );
    if ((open.rowCount ?? 0) > 0) {
      throw conflict('approval.already_pending', 'A reversal is already waiting for approval', {
        approval_id: (open.rows[0] as { id: string }).id,
      });
    }
    const ins = await tx.query(
      `INSERT INTO approvals (kind, ref_id, requested_by, reason)
       VALUES ('payment_reversal', $1, $2, $3) RETURNING id`,
      [paymentId, actor.id, reason],
    );
    const id = (ins.rows[0] as { id: string }).id;
    await audit(tx, {
      actor: actor.id,
      action: 'payment.reverse_request',
      entityType: 'approval',
      entityId: id,
      after: { payment_id: paymentId, reason },
      ip: ctx.ip,
      deviceId: actor.device_id,
    });
    return { approval_id: id, status: 'pending' as const };
  });
}

interface ApprovalRow {
  id: string;
  kind: string;
  ref_id: string;
  requested_by: string;
  reason: string | null;
  status: string;
}

async function lockApproval(tx: pg.PoolClient, id: string, actor: AuthUser): Promise<ApprovalRow> {
  const res = await tx.query(
    `SELECT id, kind, ref_id, requested_by, reason, status FROM approvals WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const a = res.rows[0] as ApprovalRow | undefined;
  if (!a) throw notFound('approval.not_found', 'Approval not found');
  if (a.status !== 'pending') {
    throw conflict('approval.already_decided', `This request is already ${a.status}`);
  }
  // Separation of duties (the table also has a CHECK): nobody decides their own request.
  if (a.requested_by === actor.id) {
    throw forbidden('approval.self_decision', 'You cannot decide your own request');
  }
  if (a.kind !== 'payment_reversal') {
    throw badRequest('approval.kind_unsupported', `Approvals of kind ${a.kind} are not available yet`);
  }
  return a;
}

/** `POST /approvals/:id/approve` (auditor, step-up): performs the reversal in one transaction. */
export async function approveApproval(
  deps: PaymentDeps,
  actor: AuthUser,
  approvalId: string,
  note: string | undefined,
  ctx: ClientCtx,
): Promise<{ id: string; status: 'approved'; payment_id: string; reversal_seqs: string[] }> {
  return inTransaction(deps.pool, async (tx) => {
    const a = await lockApproval(tx, approvalId, actor);
    const paymentId = a.ref_id;

    const res = await tx.query(`SELECT status FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const p = res.rows[0] as { status: string } | undefined;
    if (!p) throw notFound('payment.not_found', 'Payment not found');
    if (p.status !== 'confirmed') {
      throw conflict('payment.not_confirmed', 'Only a confirmed payment can be reversed');
    }

    const reversals = await reverseReference(tx, LEDGER_REF.payment, paymentId, {
      reason: a.reason ?? 'Payment reversed',
      actor: { userId: actor.id, ip: ctx.ip, deviceId: actor.device_id },
      clock: deps.clock,
    });

    // Negative allocation rows reopen the dues and fines this payment had paid (including credit it
    // had since been spent on). The payment's unspent credit goes with it.
    await tx.query(
      `INSERT INTO payment_allocations (payment_id, due_id, fine_id, amount_paisa)
       SELECT payment_id, due_id, fine_id, -SUM(amount_paisa)
       FROM payment_allocations WHERE payment_id = $1
       GROUP BY payment_id, due_id, fine_id
       HAVING SUM(amount_paisa) > 0`,
      [paymentId],
    );
    await tx.query(`UPDATE payments SET status = 'reversed', unallocated_paisa = 0 WHERE id = $1`, [
      paymentId,
    ]);
    await tx.query(
      `UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = $3 WHERE id = $1`,
      [approvalId, actor.id, deps.clock.now()],
    );
    await audit(tx, {
      actor: actor.id,
      action: 'payment.reverse',
      entityType: 'payment',
      entityId: paymentId,
      after: {
        approval_id: approvalId,
        reason: a.reason,
        note: note ?? null,
        reversal_seqs: reversals.map((r) => r.seq.toString()),
      },
      ip: ctx.ip,
      deviceId: actor.device_id,
    });
    return {
      id: approvalId,
      status: 'approved' as const,
      payment_id: paymentId,
      reversal_seqs: reversals.map((r) => r.seq.toString()),
    };
  });
}

/** `POST /approvals/:id/reject` (auditor, step-up). */
export async function rejectApproval(
  deps: PaymentDeps,
  actor: AuthUser,
  approvalId: string,
  note: string | undefined,
  ctx: ClientCtx,
): Promise<{ id: string; status: 'rejected' }> {
  return inTransaction(deps.pool, async (tx) => {
    const a = await lockApproval(tx, approvalId, actor);
    await tx.query(
      `UPDATE approvals SET status = 'rejected', decided_by = $2, decided_at = $3 WHERE id = $1`,
      [approvalId, actor.id, deps.clock.now()],
    );
    await audit(tx, {
      actor: actor.id,
      action: 'approval.reject',
      entityType: 'approval',
      entityId: approvalId,
      after: { kind: a.kind, ref_id: a.ref_id, note: note ?? null },
      ip: ctx.ip,
      deviceId: actor.device_id,
    });
    return { id: approvalId, status: 'rejected' as const };
  });
}

/** `GET /approvals` (cashier, auditor): the requests with who asked, and the payment they concern. */
export async function listApprovals(
  deps: PaymentDeps,
  q: ApprovalsQuery,
): Promise<{ items: unknown[]; next_cursor: string | null }> {
  const cursor = decodeCursor(q.cursor, 2); // [created_at, id]
  const res = await deps.pool.query(
    `SELECT a.id, a.kind, a.ref_id, a.reason, a.status, a.created_at, a.decided_at,
            ${tsKey('a.created_at')} AS created_key,
            rm.code AS requested_by_code, dm.code AS decided_by_code,
            p.member_id AS payment_member_id, pm.code AS payment_member_code,
            p.amount_paisa AS payment_amount_paisa, p.method AS payment_method,
            p.trx_id AS payment_trx_id
     FROM approvals a
     LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN members rm ON rm.id = ru.member_id
     LEFT JOIN users du ON du.id = a.decided_by LEFT JOIN members dm ON dm.id = du.member_id
     LEFT JOIN payments p ON a.kind = 'payment_reversal' AND p.id::text = a.ref_id
     LEFT JOIN members pm ON pm.id = p.member_id
     WHERE ($1::text IS NULL OR a.status = $1) AND ($2::text IS NULL OR a.kind = $2)
       AND ($3::timestamptz IS NULL OR (a.created_at, a.id) < ($3::timestamptz, $4::uuid))
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $5`,
    [q.status ?? null, q.kind ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, q.limit + 1],
  );
  const rows = res.rows as Array<Record<string, unknown> & { id: string; created_key: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ created_key: _k, payment_amount_paisa, ...r }) => ({
      ...r,
      payment_amount_paisa: payment_amount_paisa === null ? null : paisaOut(payment_amount_paisa),
    })),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.created_key, last.id]) : null,
  };
}

// ---- reads ----------------------------------------------------------------------------------

const PAYMENT_SELECT = `
  p.id, p.member_id, m.code AS member_code, m.full_name AS member_name, p.amount_paisa, p.method,
  p.purpose, p.trx_id, p.paid_at, p.status, p.source, p.for_periods, p.proof_file_id,
  (p.raw_sms IS NOT NULL) AS has_raw_sms, p.note, p.reject_reason, p.unallocated_paisa,
  p.submitted_at, p.confirmed_at, cm.code AS confirmed_by_code,
  ${tsKey('p.paid_at')} AS sort_key
  FROM payments p
  JOIN members m ON m.id = p.member_id
  LEFT JOIN users cu ON cu.id = p.confirmed_by
  LEFT JOIN members cm ON cm.id = cu.member_id`;

type PaymentRow = Record<string, unknown> & { id: string; member_id: string; sort_key: string };

/**
 * Everyone sees who paid how much, by which method and the status (transparency); the TrxID, note,
 * rejection reason and proof belong to the payer, the cashier and the auditor (spec 7).
 */
function shapePayment(row: PaymentRow, viewer: AuthUser): Record<string, unknown> {
  const { sort_key: _key, ...rest } = row;
  const detail = isPrivileged(viewer) || viewer.member_id === row.member_id;
  return {
    ...rest,
    amount_paisa: paisaOut(row['amount_paisa']),
    unallocated_paisa: paisaOut(row['unallocated_paisa']),
    trx_id: detail ? row['trx_id'] : null,
    note: detail ? row['note'] : null,
    reject_reason: detail ? row['reject_reason'] : null,
    proof_file_id: detail ? row['proof_file_id'] : null,
    has_raw_sms: detail ? row['has_raw_sms'] : false,
  };
}

/**
 * `GET /payments?status&member_id&cursor&limit`, most recently paid first. By payment date, not
 * submission: imported history is all submitted at once, and a late submission belongs where it was paid.
 */
export async function listPayments(
  deps: PaymentDeps,
  viewer: AuthUser,
  q: PaymentsQuery,
): Promise<{ items: unknown[]; next_cursor: string | null }> {
  const cursor = decodeCursor(q.cursor, 2); // [paid_at, id]
  const res = await deps.pool.query(
    `SELECT ${PAYMENT_SELECT}
     WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.member_id = $2)
       AND ($3::timestamptz IS NULL OR (p.paid_at, p.id) < ($3::timestamptz, $4::uuid))
     ORDER BY p.paid_at DESC, p.id DESC
     LIMIT $5`,
    [q.status ?? null, q.member_id ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, q.limit + 1],
  );
  const rows = res.rows as PaymentRow[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => shapePayment(r, viewer)),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.sort_key, last.id]) : null,
  };
}

/**
 * `GET /payments/:id`: the list row plus what was allocated, the raw SMS (payer, cashier, auditor,
 * audited as a sensitive read, 19.4) and, for the cashier on a pending payment, a preview of what
 * confirming would do (for the confirmation sheet).
 */
export async function getPayment(
  deps: PaymentDeps,
  viewer: AuthUser,
  id: string,
  ctx: ClientCtx,
): Promise<Record<string, unknown>> {
  const res = await deps.pool.query(`SELECT ${PAYMENT_SELECT} WHERE p.id = $1`, [id]);
  const row = res.rows[0] as PaymentRow | undefined;
  if (!row) throw notFound('payment.not_found', 'Payment not found');
  const out = shapePayment(row, viewer);
  const detail = isPrivileged(viewer) || viewer.member_id === row.member_id;

  const allocations = await deps.pool.query(
    `SELECT a.due_id, a.fine_id, d.period, d.kind AS due_kind, SUM(a.amount_paisa) AS amount_paisa
     FROM payment_allocations a
     LEFT JOIN dues d ON d.id = a.due_id
     WHERE a.payment_id = $1
     GROUP BY a.due_id, a.fine_id, d.period, d.kind
     HAVING SUM(a.amount_paisa) <> 0
     ORDER BY d.period NULLS LAST`,
    [id],
  );
  out['allocations'] = (allocations.rows as Array<Record<string, unknown>>).map((a) => ({
    ...a,
    amount_paisa: paisaOut(a['amount_paisa']),
  }));

  out['raw_sms'] = null;
  if (detail && row['has_raw_sms']) {
    const sms = await deps.pool.query(`SELECT raw_sms FROM payments WHERE id = $1`, [id]);
    out['raw_sms'] = (sms.rows[0] as { raw_sms: string }).raw_sms;
    await audit(deps.pool, {
      actor: viewer.id,
      action: 'payment.view_raw_sms',
      entityType: 'payment',
      entityId: id,
      ip: ctx.ip,
      deviceId: viewer.device_id,
    });
  }

  out['preview'] = null;
  if (viewer.roles.includes('cashier') && row['status'] === 'pending') {
    const items = await openItems(deps.pool, row.member_id, (row['purpose'] ?? 'dues') as PaymentPurpose);
    out['preview'] = planOut(planDefaultAllocation(toBigInt(row['amount_paisa']), items.dues, items.fines));
  }
  return out;
}

// ---- SMS parsing ----------------------------------------------------------------------------

/**
 * `POST /payments/parse-sms` (cashier): parse and look for the pending payment it belongs to: the
 * same TrxID, or the same amount paid within 3 days of the SMS time. It only suggests (5.4).
 */
export async function parseSms(deps: PaymentDeps, input: ParseSms): Promise<Record<string, unknown>> {
  const parsed = parsePaymentSms(input.text);
  const matches: unknown[] = [];

  if (parsed.parsed && parsed.amount_paisa !== null) {
    const when = parsed.paid_at ? new Date(parsed.paid_at) : deps.clock.now();
    const res = await deps.pool.query(
      `SELECT p.id, p.member_id, m.code AS member_code, p.amount_paisa,
              COALESCE($1::text IS NOT NULL AND upper(trim(p.trx_id)) = upper($1::text), false)
                AS trx_match
       FROM payments p JOIN members m ON m.id = p.member_id
       WHERE p.status = 'pending'
         AND (($1::text IS NOT NULL AND upper(trim(p.trx_id)) = upper($1::text))
              OR (p.amount_paisa = $2::bigint
                  AND abs(extract(epoch FROM (p.paid_at - $3::timestamptz))) <= $4::int * 86400))
       ORDER BY trx_match DESC, p.submitted_at`,
      [parsed.trx_id, parsed.amount_paisa.toString(), when, SMS_MATCH_WINDOW_DAYS],
    );
    for (const r of res.rows as Array<Record<string, unknown>>) {
      const sameAmount = toBigInt(r['amount_paisa']) === parsed.amount_paisa;
      const byTrx = r['trx_match'] === true;
      matches.push({
        payment_id: r['id'],
        match_type: byTrx ? 'trx_id' : 'amount_phone',
        member_id: r['member_id'],
        member_code: r['member_code'],
        amount_paisa: paisaOut(r['amount_paisa']),
        exact: byTrx && sameAmount,
      });
    }
  }

  return {
    parsed: parsed.parsed,
    method: parsed.method,
    amount_paisa: parsed.amount_paisa === null ? null : parsed.amount_paisa.toString(),
    trx_id: parsed.trx_id,
    paid_at: parsed.paid_at,
    counterparty_phone: parsed.counterparty_phone,
    balance_paisa: parsed.balance_paisa === null ? null : parsed.balance_paisa.toString(),
    matches,
  };
}

