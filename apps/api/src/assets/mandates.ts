import type pg from 'pg';
import { addMonths, type CashAccountCode, type Clock, type MandatePurchase } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { getRule } from '../lib/rules';
import { toBigInt } from '../lib/money';
import { inTransaction, type Db } from '../lib/tx';
import { postEntries, reverseReference, type LedgerActor } from '../ledger/service';

/**
 * Standing investment approvals (ASSUMPTIONS 131, owner decision): the members vote once that up to a
 * monthly limit goes to one shop for a set number of months. Each purchase under it is an `assets`
 * row (as every shop purchase is) plus `DR INVESTMENTS_AT_COST, CR <account>` with
 * `ref_type='mandate_purchase'` and `ref_id=<asset id>`. It comes either from the cashier (money sent
 * from the fund's account, with the shop's receipt) or from a member's payment sent straight to the
 * shop. Either way it counts against that month's limit.
 */

export const MANDATE_REF = 'mandate_purchase';

export interface MandateDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface MandateRow {
  id: string;
  proposal_id: string;
  partner_id: string;
  partner_name: string;
  partner_kind: 'gold' | 'land' | 'house' | 'other';
  monthly_max_paisa: string;
  first_period: string;
  last_period: string;
  compliance: Record<string, unknown>;
  ended_on: string | null;
}

const MANDATE_COLUMNS = `m.id, m.proposal_id, m.partner_id, p.name AS partner_name, p.kind AS partner_kind,
  m.monthly_max_paisa::text AS monthly_max_paisa, m.first_period, m.last_period, m.compliance,
  m.ended_on::text AS ended_on`;

/** Last period of a mandate that starts at `first` and runs for `months` months. */
export function mandateLastPeriod(first: string, months: number): string {
  return addMonths(first, months - 1);
}

/**
 * The mandate that covers a purchase from `partnerId` dated `date`, locked for the caller's
 * transaction so two purchases cannot both squeeze under the limit. Ending a mandate stops purchases
 * dated on or after the day it ended.
 */
export async function mandateFor(tx: Db, partnerId: string, date: string): Promise<MandateRow | null> {
  const res = await tx.query(
    `SELECT ${MANDATE_COLUMNS}
     FROM investment_mandates m JOIN investment_partners p ON p.id = m.partner_id
     WHERE m.partner_id = $1 AND to_char($2::date, 'YYYY-MM') BETWEEN m.first_period AND m.last_period
       AND (m.ended_on IS NULL OR $2::date < m.ended_on)
     ORDER BY m.created_at DESC
     LIMIT 1
     FOR UPDATE OF m`,
    [partnerId, date],
  );
  return (res.rows[0] as MandateRow | undefined) ?? null;
}

/** What has gone to the shop under a mandate in one month (reversed purchases count as nothing). */
export async function usedInPeriod(db: Db, mandateId: string, period: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(cost_paisa), 0)::text AS used FROM assets
     WHERE mandate_id = $1 AND to_char(acquired_on, 'YYYY-MM') = $2`,
    [mandateId, period],
  );
  return toBigInt((res.rows[0] as { used: string }).used);
}

export interface PurchaseInput {
  mandate: MandateRow;
  entryDate: string;
  amountPaisa: bigint;
  /** Where the money came from in the books; a member's direct payment passes through its method account. */
  account: string;
  memberId?: string | null;
  paymentId?: string | null;
  quantity?: number | undefined;
  unit?: 'vori' | 'gram' | undefined;
  note?: string | null | undefined;
}

/** Records one purchase under `mandate` in the caller's transaction; refuses anything over the month's limit. */
export async function recordPurchase(tx: Db, actor: LedgerActor, i: PurchaseInput): Promise<{ asset_id: string; ledger_seq: string }> {
  const period = i.entryDate.slice(0, 7);
  const used = await usedInPeriod(tx, i.mandate.id, period);
  const max = toBigInt(i.mandate.monthly_max_paisa);
  if (used + i.amountPaisa > max) {
    throw badRequest('mandate.over_limit', 'This would go past the monthly limit the members approved', {
      monthly_max_paisa: max.toString(),
      used_paisa: used.toString(),
      left_paisa: (max > used ? max - used : 0n).toString(),
    });
  }
  const asset = await tx.query(
    `INSERT INTO assets (kind, name, description, cost_paisa, quantity, unit, status, acquired_on, proposal_id,
                         compliance, partner_id, mandate_id, payment_id)
     VALUES ($1, $2, $3, $4::bigint, $5, $6, 'held', $7::date, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      i.mandate.partner_kind,
      `${i.mandate.partner_name} ${period}`,
      i.note ?? null,
      i.amountPaisa.toString(),
      i.quantity ?? null,
      i.unit ?? null,
      i.entryDate,
      i.mandate.proposal_id,
      JSON.stringify(i.mandate.compliance),
      i.mandate.partner_id,
      i.mandate.id,
      i.paymentId ?? null,
    ],
  );
  const assetId = (asset.rows[0] as { id: string }).id;
  const [entry] = await postEntries(
    tx,
    [
      {
        entry_date: i.entryDate,
        debit: 'INVESTMENTS_AT_COST',
        credit: i.account,
        amount_paisa: i.amountPaisa,
        member_id: i.memberId ?? null,
        ref_type: MANDATE_REF,
        ref_id: assetId,
        memo: i.paymentId ? `Sent straight to ${i.mandate.partner_name}` : `Monthly purchase: ${i.mandate.partner_name}${i.note ? ` - ${i.note}` : ''}`,
      },
    ],
    actor,
  );
  return { asset_id: assetId, ledger_seq: entry!.seq.toString() };
}

/** `POST /mandates/:id/purchases` (cashier, step-up): money sent from the fund's account to the shop. */
export async function addMandatePurchase(
  deps: MandateDeps,
  actor: LedgerActor,
  mandateId: string,
  input: MandatePurchase,
): Promise<{ asset_id: string; ledger_seq: string }> {
  if (input.entry_date > deps.clock.todayDhaka()) {
    throw badRequest('mandate.future_date', 'The date the money went to the shop cannot be in the future');
  }
  return inTransaction(deps.pool, async (tx) => {
    const exists = await tx.query(`SELECT partner_id FROM investment_mandates WHERE id = $1`, [mandateId]);
    const partnerId = (exists.rows[0] as { partner_id: string } | undefined)?.partner_id;
    if (!partnerId) throw notFound('mandate.not_found', 'Standing approval not found');
    const mandate = await mandateFor(tx, partnerId, input.entry_date);
    if (!mandate || mandate.id !== mandateId) {
      throw badRequest('mandate.not_in_force', 'This approval does not cover that date');
    }
    const file = await tx.query(`SELECT 1 FROM files WHERE id = $1`, [input.receipt_file_id]);
    if (file.rowCount === 0) throw badRequest('mandate.receipt_required', 'Attach the shop\'s receipt');

    // One pool by default: checked against cash, bank, bKash and Nagad together (ASSUMPTIONS 96).
    const perMethod = (await getRule(tx, 'cash_tracking_by_method', deps.clock.todayDhaka()))?.value === true;
    const account: CashAccountCode = perMethod ? input.account : 'BANK';
    const held = await tx.query(
      `SELECT COALESCE(SUM(natural_balance_paisa), 0)::text AS p FROM v_account_balances WHERE code = ANY($1::text[])`,
      [perMethod ? [account] : ['CASH', 'BANK', 'BKASH', 'NAGAD']],
    );
    const available = toBigInt((held.rows[0] as { p: string }).p);
    if (input.amount_paisa > available) {
      throw badRequest('mandate.insufficient_funds', `The fund holds ${available}, which is less than ${input.amount_paisa}`);
    }

    const out = await recordPurchase(tx, actor, {
      mandate,
      entryDate: input.entry_date,
      amountPaisa: input.amount_paisa,
      account,
      quantity: input.quantity,
      unit: input.unit,
      note: input.note,
    });
    await tx.query(
      `INSERT INTO documents (file_id, entity_type, entity_id, doc_type, title) VALUES ($1, 'asset', $2, 'receipt', NULL)`,
      [input.receipt_file_id, out.asset_id],
    );
    await audit(tx, {
      actor: actor.userId,
      action: 'mandate.purchase',
      entityType: 'asset',
      entityId: out.asset_id,
      after: { mandate_id: mandateId, amount_paisa: input.amount_paisa.toString(), entry_date: input.entry_date, ledger_seq: out.ledger_seq },
      ip: actor.ip,
      deviceId: actor.deviceId ?? null,
    });
    return out;
  });
}

/** `POST /mandates/:id/end` (cashier or auditor, step-up): no purchase dated today or later. */
export async function endMandate(deps: MandateDeps, actor: LedgerActor, mandateId: string, reason: string): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(`SELECT ended_on FROM investment_mandates WHERE id = $1 FOR UPDATE`, [mandateId]);
    const row = res.rows[0] as { ended_on: Date | null } | undefined;
    if (!row) throw notFound('mandate.not_found', 'Standing approval not found');
    if (row.ended_on) throw conflict('mandate.already_ended', 'This approval has already ended');
    await tx.query(`UPDATE investment_mandates SET ended_on = $2::date, ended_by = $3, end_reason = $4 WHERE id = $1`, [
      mandateId,
      deps.clock.todayDhaka(),
      actor.userId,
      reason,
    ]);
    await audit(tx, { actor: actor.userId, action: 'mandate.end', entityType: 'mandate', entityId: mandateId, after: { reason }, ip: actor.ip, deviceId: actor.deviceId ?? null });
  });
}

/** Every standing approval with what went to the shop this month, newest first. Everyone may read it. */
export async function listMandates(db: Db, today: string, partnerId?: string): Promise<{ items: Record<string, unknown>[] }> {
  const res = await db.query(
    `SELECT ${MANDATE_COLUMNS}, pr.title AS proposal_title, m.end_reason, m.created_at,
            COALESCE((SELECT SUM(a.cost_paisa) FROM assets a
                      WHERE a.mandate_id = m.id AND to_char(a.acquired_on, 'YYYY-MM') = to_char($1::date, 'YYYY-MM')), 0)::text AS used_this_month_paisa,
            COALESCE((SELECT SUM(a.cost_paisa) FROM assets a WHERE a.mandate_id = m.id), 0)::text AS total_paisa
     FROM investment_mandates m
     JOIN investment_partners p ON p.id = m.partner_id
     JOIN proposals pr ON pr.id = m.proposal_id
     WHERE ($2::uuid IS NULL OR m.partner_id = $2)
     ORDER BY m.created_at DESC`,
    [today, partnerId ?? null],
  );
  const period = today.slice(0, 7);
  return {
    items: (res.rows as Array<MandateRow & Record<string, unknown>>).map(({ compliance: _c, ...m }) => ({
      ...m,
      status: m.ended_on ? 'ended' : period < m.first_period ? 'upcoming' : period > m.last_period ? 'expired' : 'active',
    })),
  };
}

/** Purchases under one mandate with their ledger entry and whether a reversal is waiting or done. */
export async function listMandatePurchases(db: Db, mandateId: string): Promise<{ items: Record<string, unknown>[] }> {
  const res = await db.query(
    `SELECT a.id AS asset_id, a.acquired_on::text AS entry_date, a.cost_paisa::text AS amount_paisa, a.description AS note,
            a.payment_id, mb.code AS member_code, mb.full_name AS member_name,
            l.seq::text AS ledger_seq, l.amount_paisa::text AS original_paisa,
            EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_seq = l.seq) AS reversed,
            EXISTS (SELECT 1 FROM approvals ap WHERE ap.kind = 'mandate_purchase_reversal' AND ap.ref_id = a.id::text
                    AND ap.status = 'pending') AS reversal_pending,
            (SELECT d.file_id FROM documents d WHERE d.entity_type = 'asset' AND d.entity_id = a.id ORDER BY d.created_at LIMIT 1) AS receipt_file_id
     FROM assets a
     JOIN ledger_entries l ON l.ref_type = '${MANDATE_REF}' AND l.ref_id = a.id AND l.reverses_seq IS NULL
     LEFT JOIN members mb ON mb.id = l.member_id
     WHERE a.mandate_id = $1
     ORDER BY a.acquired_on DESC, l.seq DESC`,
    [mandateId],
  );
  return { items: res.rows as Record<string, unknown>[] };
}

/** `POST /mandate-purchases/:id/reverse-request` (cashier): the auditor reverses it. */
export async function requestPurchaseReversal(
  deps: MandateDeps,
  actor: LedgerActor,
  assetId: string,
  reason: string,
): Promise<{ approval_id: string }> {
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(`SELECT mandate_id, payment_id, cost_paisa FROM assets WHERE id = $1 FOR UPDATE`, [assetId]);
    const a = res.rows[0] as { mandate_id: string | null; payment_id: string | null; cost_paisa: string } | undefined;
    if (!a?.mandate_id) throw notFound('mandate.purchase_not_found', 'Purchase not found');
    // A member's payment sent to the shop is undone by reversing the payment itself.
    if (a.payment_id) throw badRequest('mandate.reverse_the_payment', 'Reverse the member\'s payment instead');
    if (toBigInt(a.cost_paisa) === 0n) throw conflict('mandate.already_reversed', 'This purchase has already been reversed');
    const open = await tx.query(
      `SELECT 1 FROM approvals WHERE kind = 'mandate_purchase_reversal' AND ref_id = $1 AND status = 'pending'`,
      [assetId],
    );
    if ((open.rowCount ?? 0) > 0) throw conflict('approval.already_pending', 'A reversal is already waiting for approval');
    const ins = await tx.query(
      `INSERT INTO approvals (kind, ref_id, requested_by, reason) VALUES ('mandate_purchase_reversal', $1, $2, $3) RETURNING id`,
      [assetId, actor.userId, reason],
    );
    const id = (ins.rows[0] as { id: string }).id;
    await audit(tx, { actor: actor.userId, action: 'mandate.reverse_request', entityType: 'approval', entityId: id, after: { asset_id: assetId, reason }, ip: actor.ip, deviceId: actor.deviceId ?? null });
    return { approval_id: id };
  });
}

/**
 * Undo one purchase in the caller's transaction: its ledger entry is reversed (never edited), and the
 * asset's cost goes to zero with a zero valuation, so neither NAV nor a later value update counts it.
 */
export async function undoPurchase(
  tx: Db,
  clock: Clock,
  actor: LedgerActor,
  assetId: string,
  reason: string,
  approvalId: string | null,
): Promise<string[]> {
  const reversals = await reverseReference(tx, MANDATE_REF, assetId, { reason, actor, clock });
  await tx.query(`UPDATE assets SET cost_paisa = 0 WHERE id = $1`, [assetId]);
  await tx.query(
    `INSERT INTO asset_valuations (asset_id, value_paisa, as_of, basis, approval_id) VALUES ($1, 0, $2::date, 'reversal', $3)`,
    [assetId, clock.todayDhaka(), approvalId],
  );
  return reversals.map((r) => r.seq.toString());
}
