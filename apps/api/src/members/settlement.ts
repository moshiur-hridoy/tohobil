import type pg from 'pg';
import { divRound, formatBDT, methodAccount, type Clock, type PaymentMethod, type SettlementKind } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { type Db } from '../lib/tx';
import { toBigInt } from '../lib/money';
import { ruleInt, rulePaisa } from '../lib/rules';
import { type LedgerActor, LEDGER_REF, postEntries } from '../ledger/service';
import { notifyMember } from '../notifications/service';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import type { Logger } from 'pino';
import {
  computeMemberFinancials,
  createMemberSnapshot,
  transitionMemberStatus,
} from './status';

export interface SettlementDeps {
  pool: pg.Pool;
  clock: Clock;
  pushSender: PushSender;
  smsProvider: SmsProvider;
  log?: Logger;
}

interface SettlementRow {
  id: string;
  member_id: string;
  snapshot_id: string;
  proposal_id: string;
  kind: SettlementKind;
  net_paisa: string;
  payout_plan: Array<{ due_on: string; amount_paisa: string }>;
  status: 'approved' | 'paying' | 'completed';
}

interface SettlementQuoteInput {
  kind: SettlementKind;
  payout_plan: Array<{ due_on: string; amount_paisa: bigint }>;
  proposal_id?: string | null;
}

interface SettlementQuote {
  settlement_id: string;
  snapshot_id: string;
  member_id: string;
  kind: SettlementKind;
  gross: bigint;
  escrow: bigint;
  deductions: {
    principal: bigint;
    fines: bigint;
    exit_fee: bigint;
    total: bigint;
  };
  net: bigint;
  payout_plan: Array<{ due_on: string; amount_paisa: bigint }>;
}

interface MemberShortRow {
  id: string;
  code: string;
  full_name: string;
  status: string;
}

function toPaisaBig(value: string | number | bigint | unknown): bigint {
  return toBigInt(value);
}

/**
 * Compute a settlement quote per 18.6, freeze it as a member snapshot and a settlements row.
 *
 * - death_surrender and wind_up use NAV-based gross (shares * net_assets / shares_outstanding).
 * - early_exit uses paid-in capital, with a 10% service charge retained to EXIT_FEE_INCOME.
 * - compassionate_exit and inactive_return use paid-in capital with no service charge.
 *
 * The payout plan must sum to `net`; otherwise the quote is rejected.
 */
export async function computeSettlementQuote(
  db: Db,
  deps: SettlementDeps,
  memberId: string,
  input: SettlementQuoteInput,
): Promise<SettlementQuote> {
  const today = deps.clock.todayDhaka();
  const member = (await db.query(
    `SELECT id, code, full_name, status FROM members WHERE id = $1 FOR UPDATE`,
    [memberId],
  )).rows[0] as MemberShortRow | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');

  const fin = await computeMemberFinancials(db, memberId, today);
  const { kind, payout_plan: plan } = input;
  const ruleAsOf = `${today.slice(0, 7)}-01`;

  let gross: bigint;
  let exitFee = 0n;

  if (kind === 'early_exit') {
    gross = fin.capital;
    const pct = await ruleInt(db, 'early_exit_service_charge_percent', ruleAsOf);
    exitFee = divRound(fin.capital * BigInt(pct), 100n);
  } else if (kind === 'compassionate_exit' || kind === 'inactive_return') {
    gross = fin.capital;
  } else {
    // death_surrender and wind_up use the share-ratio NAV formula.
    gross = fin.sharesOutstanding > 0 ? divRound(fin.netAssets * BigInt(fin.shares), BigInt(fin.sharesOutstanding)) : 0n;
    exitFee = await rulePaisa(db, 'exit_fee_paisa', ruleAsOf).catch(() => 0n);
  }

  const deductionsTotal = fin.outstandingPrincipal + fin.outstandingFines + exitFee;
  const net = gross + fin.escrow - deductionsTotal;

  if (plan.length === 0) {
    throw badRequest('settlement.no_payout_plan', 'A payout plan is required');
  }
  const planTotal = plan.reduce((sum, p) => sum + p.amount_paisa, 0n);
  if (planTotal !== net) {
    throw badRequest(
      'settlement.payout_plan_mismatch',
      `Payout plan total ${planTotal} does not equal net ${net}`,
    );
  }

  const snapshotId = await createMemberSnapshot(db, {
    memberId,
    kind: 'settlement_quote',
    today,
    fin,
    proposalId: input.proposal_id,
    gross,
    escrow: fin.escrow,
    deductions: {
      principal_paisa: fin.outstandingPrincipal,
      fines_paisa: fin.outstandingFines,
      exit_fee_paisa: exitFee,
      total_paisa: deductionsTotal,
    },
    net,
  });

  const settlementRes = await db.query(
    `INSERT INTO settlements
       (member_id, snapshot_id, proposal_id, kind, net_paisa, payout_plan, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved')
     RETURNING id`,
    [
      memberId,
      snapshotId,
      input.proposal_id ?? null,
      kind,
      net.toString(),
      JSON.stringify(
        plan.map((p) => ({ due_on: p.due_on, amount_paisa: p.amount_paisa.toString() })),
      ),
    ],
  );

  return {
    settlement_id: (settlementRes.rows[0] as { id: string }).id,
    snapshot_id: snapshotId,
    member_id: memberId,
    kind,
    gross,
    escrow: fin.escrow,
    deductions: {
      principal: fin.outstandingPrincipal,
      fines: fin.outstandingFines,
      exit_fee: exitFee,
      total: deductionsTotal,
    },
    net,
    payout_plan: plan,
  };
}

/**
 * Execute an approved settlement: post capital and escrow to SETTLEMENT_PAYABLE, end
 * share holdings and create payout rows. `net` must be >= 0.
 */
export async function executeSettlement(
  tx: pg.PoolClient,
  deps: SettlementDeps,
  settlementId: string,
  actor: LedgerActor,
): Promise<SettlementQuote> {
  const today = deps.clock.todayDhaka();
  const settlement = await loadSettlement(tx, settlementId);
  const member = (await tx.query(
    `SELECT id, code, full_name, status FROM members WHERE id = $1 FOR UPDATE`,
    [settlement.member_id],
  )).rows[0] as MemberShortRow | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');

  const net = toPaisaBig(settlement.net_paisa);
  if (net < 0n) {
    throw badRequest(
      'settlement.negative_net',
      'Settlement cannot execute with a negative net; pay shortfall or reduce deductions first',
    );
  }

  const snap = (await tx.query(`SELECT * FROM member_snapshots WHERE id = $1`, [settlement.snapshot_id]))
    .rows[0] as {
    gross_paisa: string | number | bigint | null;
    escrow_paisa: string | number | bigint | null;
    deductions: Record<string, string>;
    net_assets_paisa: string | number | bigint;
    shares_outstanding: number;
  } | undefined;
  if (!snap) throw notFound('settlement.snapshot_not_found', 'Snapshot not found');

  const gross = snap.gross_paisa != null ? toPaisaBig(snap.gross_paisa) : 0n;
  const escrow = snap.escrow_paisa != null ? toPaisaBig(snap.escrow_paisa) : 0n;
  const deductionsTotal = toPaisaBig(snap.deductions['total_paisa'] ?? 0);
  const capitalPosting = gross - deductionsTotal;

  const entries = [];
  if (capitalPosting > 0n) {
    entries.push({
      entry_date: today,
      debit: 'MEMBER_CAPITAL',
      credit: 'SETTLEMENT_PAYABLE',
      amount_paisa: capitalPosting,
      member_id: settlement.member_id,
      ref_type: LEDGER_REF.proposal,
      ref_id: settlement.proposal_id,
      memo: `Settlement ${settlement.kind} capital`,
    });
  }
  if (escrow > 0n) {
    entries.push({
      entry_date: today,
      debit: 'MEMBER_ESCROW',
      credit: 'SETTLEMENT_PAYABLE',
      amount_paisa: escrow,
      member_id: settlement.member_id,
      ref_type: LEDGER_REF.proposal,
      ref_id: settlement.proposal_id,
      memo: `Settlement ${settlement.kind} escrow`,
    });
  }

  // Postings must be balanced to the net settlement payable.
  const postedTotal = entries.reduce((s, e) => s + e.amount_paisa, 0n);
  if (postedTotal !== net && entries.length > 0) {
    throw badRequest('settlement.posting_mismatch', 'Ledger postings do not match net settlement');
  }

  if (entries.length > 0) {
    await postEntries(tx, entries, actor);
  }

  await tx.query(
    `UPDATE share_holdings SET effective_to = $2 WHERE member_id = $1 AND (effective_to IS NULL OR effective_to > $2)`,
    [settlement.member_id, today],
  );

  // The member remains in their previous status until the settlement is fully paid;
  // full exit (status 'exited', user disabled) happens when SETTLEMENT_PAYABLE reaches zero.

  await tx.query(
    `UPDATE settlements SET status = 'paying' WHERE id = $1`,
    [settlementId],
  );

  for (const p of settlement.payout_plan) {
    await tx.query(
      `INSERT INTO settlement_payouts (settlement_id, due_on, amount_paisa)
       VALUES ($1, $2, $3)`,
      [settlementId, p.due_on, p.amount_paisa],
    );
  }

  await audit(tx, {
    actor: actor.userId,
    action: 'settlement.execute',
    entityType: 'settlement',
    entityId: settlementId,
    after: {
      member_id: settlement.member_id,
      kind: settlement.kind,
      net_paisa: net.toString(),
      capital_posted_paisa: capitalPosting.toString(),
      escrow_posted_paisa: escrow.toString(),
    },
    ip: actor.ip,
    deviceId: actor.deviceId ?? null,
  });

  return {
    settlement_id: settlementId,
    snapshot_id: settlement.snapshot_id,
    member_id: settlement.member_id,
    kind: settlement.kind,
    gross,
    escrow,
    deductions: {
      principal: toPaisaBig(snap.deductions['principal_paisa'] ?? 0),
      fines: toPaisaBig(snap.deductions['fines_paisa'] ?? 0),
      exit_fee: toPaisaBig(snap.deductions['exit_fee_paisa'] ?? 0),
      total: deductionsTotal,
    },
    net,
    payout_plan: settlement.payout_plan.map((p) => ({
      due_on: p.due_on,
      amount_paisa: toPaisaBig(p.amount_paisa),
    })),
  };
}

async function loadSettlement(db: Db, settlementId: string): Promise<SettlementRow> {
  const res = await db.query(`SELECT * FROM settlements WHERE id = $1`, [settlementId]);
  const row = res.rows[0] as SettlementRow | undefined;
  if (!row) throw notFound('settlement.not_found', 'Settlement not found');
  if (row.status === 'completed') {
    throw conflict('settlement.already_completed', 'Settlement is already completed');
  }
  return row;
}

/** Remaining SETTLEMENT_PAYABLE liability for a member. */
async function settlementPayableBalance(db: Db, memberId: string): Promise<bigint> {
  const res = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN credit_account = 'SETTLEMENT_PAYABLE' AND member_id = $1 THEN amount_paisa ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN debit_account = 'SETTLEMENT_PAYABLE' AND member_id = $1 THEN amount_paisa ELSE 0 END), 0)
       AS bal
     FROM ledger_entries`,
    [memberId],
  );
  return toPaisaBig((res.rows[0] as { bal: string | number | bigint }).bal);
}

interface PayoutInput {
  amount_paisa: bigint;
  method: PaymentMethod;
  trx_id?: string | null;
  note?: string | null;
}

/**
 * Record a settlement payout, post the cash entry and, when the payable reaches zero,
 * mark the member exited and disable their user account.
 */
export async function recordSettlementPayout(
  db: Db,
  deps: SettlementDeps,
  payoutId: string,
  input: PayoutInput,
  actor: LedgerActor,
): Promise<void> {
  const today = deps.clock.todayDhaka();
  const payout = (await db.query(
    `SELECT p.*, s.member_id, s.status AS settlement_status
     FROM settlement_payouts p
     JOIN settlements s ON s.id = p.settlement_id
     WHERE p.id = $1`,
    [payoutId],
  )).rows[0] as
    | {
        id: string;
        settlement_id: string;
        member_id: string;
        due_on: string;
        amount_paisa: string;
        paid_at: Date | null;
        settlement_status: 'approved' | 'paying' | 'completed';
      }
    | undefined;
  if (!payout) throw notFound('settlement.payout_not_found', 'Payout not found');
  if (payout.settlement_status === 'completed') {
    throw conflict('settlement.already_completed', 'Settlement is already completed');
  }
  if (payout.paid_at) {
    throw conflict('settlement.payout_already_paid', 'Payout has already been recorded');
  }

  const amount = input.amount_paisa;
  if (amount <= 0n) {
    throw badRequest('settlement.payout_amount_invalid', 'Payout amount must be positive');
  }

  const outstanding = await settlementPayableBalance(db, payout.member_id);
  if (amount > outstanding) {
    throw badRequest(
      'settlement.payout_too_large',
      `Payout ${amount} exceeds outstanding settlement payable ${outstanding}`,
    );
  }

  await postEntries(
    db as pg.PoolClient,
    [
      {
        entry_date: today,
        debit: 'SETTLEMENT_PAYABLE',
        credit: methodAccount(input.method),
        amount_paisa: amount,
        member_id: payout.member_id,
        ref_type: LEDGER_REF.settlementPayout,
        ref_id: payout.id,
        memo: input.note ?? `Settlement payout ${today}`,
      },
    ],
    actor,
  );

  await db.query(
    `UPDATE settlement_payouts SET paid_at = now(), ledger_seq = currval('ledger_entries_seq_seq') WHERE id = $1`,
    [payoutId],
  );

  await notifyMember(
    { pool: deps.pool, clock: deps.clock, log: deps.log!, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
    db,
    {
      memberId: payout.member_id,
      template: 'settlement_payout',
      vars: {
        amount: formatBDT(amount, { digits: 'bn' }),
      },
      actor: undefined,
    },
  );

  const remaining = await settlementPayableBalance(db, payout.member_id);
  if (remaining <= 0n) {
    await db.query(
      `UPDATE settlements SET status = 'completed', completed_at = now() WHERE id = $1`,
      [payout.settlement_id],
    );
    const member = (await db.query(
      `SELECT status, exited_on FROM members WHERE id = $1`,
      [payout.member_id],
    )).rows[0] as { status: string; exited_on: string | null } | undefined;
    if (member?.status !== 'exited') {
      await transitionMemberStatus(
        db,
        payout.member_id,
        member?.status ?? 'suspended',
        'exited',
        'Settlement paid in full',
        null,
        actor.userId,
      );
    }
    if (!member?.exited_on) {
      await db.query(`UPDATE members SET exited_on = $2 WHERE id = $1`, [payout.member_id, today]);
    }
    await db.query(
      `UPDATE users SET status = 'disabled', disabled_at = now() WHERE member_id = $1`,
      [payout.member_id],
    );
  }

  await audit(db, {
    actor: actor.userId,
    action: 'settlement.payout',
    entityType: 'settlement_payout',
    entityId: payoutId,
    after: {
      settlement_id: payout.settlement_id,
      amount_paisa: amount.toString(),
      method: input.method,
      remaining_paisa: remaining.toString(),
    },
    ip: actor.ip,
    deviceId: actor.deviceId ?? null,
  });
}

export { toPaisaBig };
