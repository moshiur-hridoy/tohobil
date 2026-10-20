import { divRound, addMonths, periodStart, dateInPeriod } from '@barakah/shared';
import { postEntries } from '../../ledger/service';
import { badRequest, conflict, notFound } from '../../lib/errors';
import {
  computeNav,
  memberAccountBalance,
  memberEscrowBalance as memberEscrow,
  memberOutstandingFines,
  memberOutstandingPrincipal,
} from '../../lib/nav';
import { ruleBool, ruleInt, rulePaisa } from '../../lib/rules';
import { toBigInt } from '../../lib/money';
import type { ExecutorSignature } from './shared';
import { ledgerActor, proposalPosting, serialised } from './shared';

export const newMemberExecutor: ExecutorSignature = async (db, proposal, _input, _actor, _ctx, deps) => {
  const payload = proposal.payload as {
    name: string;
    phone: string;
    shares: number;
    nominees?: Array<{ name: string; relation: string }>;
    note?: string;
  };
  const today = deps.clock.todayDhaka();
  const windUp = await db.query(`SELECT 1 FROM settings WHERE key = 'wind_up'`);
  if ((windUp.rowCount ?? 0) > 0) {
    throw badRequest('wind_up.no_new_members', 'The fund is being wound up; no new members can join');
  }
  const nav = await computeNav(db, today);
  if (nav.stale_valuations) {
    throw badRequest('nav.stale_valuation', 'Held asset valuations are stale; run a valuation_update first');
  }
  if (nav.shares_outstanding === 0) {
    throw badRequest('nav.no_shares', 'Cannot quote entry price when no shares are outstanding');
  }

  const price = divRound(nav.net_assets * BigInt(payload.shares), BigInt(nav.shares_outstanding));

  const codeRes = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 2) AS int)), 0) + 1 AS n FROM members`,
  );
  const n = Number((codeRes.rows[0] as { n: number }).n);
  const code = `M${String(n).padStart(2, '0')}`;

  const memberRes = await db.query(
    `INSERT INTO members (code, full_name, phone, status, joined_on)
     VALUES ($1, $2, $3, 'prospective', $4::date)
     RETURNING id`,
    [code, payload.name, payload.phone, today],
  );
  const memberId = (memberRes.rows[0] as { id: string }).id;

  const expiresAt = new Date(deps.clock.now().getTime() + 7 * 24 * 3600_000).toISOString();
  const quoteRes = await db.query(
    `INSERT INTO entry_quotes (member_id, shares, net_assets_paisa, shares_outstanding, price_paisa, expires_at, proposal_id)
     VALUES ($1, $2, $3::bigint, $4, $5::bigint, $6, $7)
     RETURNING id`,
    [
      memberId,
      payload.shares,
      nav.net_assets.toString(),
      nav.shares_outstanding,
      price.toString(),
      expiresAt,
      proposal.id,
    ],
  );
  const quoteId = (quoteRes.rows[0] as { id: string }).id;

  return serialised({
    member_id: memberId,
    quote_id: quoteId,
    price_paisa: price.toString(),
    nav_per_share_paisa: nav.nav_per_share.toString(),
  });
};

export const suspensionExecutor: ExecutorSignature = async (db, proposal, _input, actor, _ctx, deps) => {
  const payload = proposal.payload as { member_id: string; reason: string; clause_ref?: string };
  const memberId = payload.member_id;
  const today = deps.clock.todayDhaka();

  const beforeRes = await db.query(`SELECT status FROM members WHERE id = $1`, [memberId]);
  const beforeRow = beforeRes.rows[0] as { status: string } | undefined;
  if (!beforeRow) throw notFound('member.not_found', 'Member not found');
  if (beforeRow.status === 'suspended') throw conflict('member.already_suspended', 'Member is already suspended');

  const nav = await computeNav(db, today);
  const capital = await memberAccountBalance(db, 'MEMBER_CAPITAL', memberId);
  const escrow = await memberEscrow(db, memberId);
  const principal = await memberOutstandingPrincipal(db, memberId);
  const fines = await memberOutstandingFines(db, memberId);
  const sharesRes = await db.query(`SELECT shares_on($1::uuid, $2::date) AS shares`, [memberId, today]);
  const shares = Number((sharesRes.rows[0] as { shares: number }).shares);

  await db.query(
    `UPDATE members SET status = 'suspended', suspended_on = $2::date WHERE id = $1`,
    [memberId, today],
  );

  await db.query(
    `INSERT INTO member_status_events (member_id, from_status, to_status, reason, proposal_id, created_by)
     VALUES ($1, $2, 'suspended', $3, $4, $5)`,
    [memberId, beforeRow.status, payload.reason, proposal.id, actor.id],
  );

  const snapshotRes = await db.query(
    `INSERT INTO member_snapshots
       (member_id, kind, taken_on, shares, net_assets_paisa, shares_outstanding, nav_per_share_paisa,
        paid_in_capital_paisa, gross_paisa, escrow_paisa, deductions, net_paisa, proposal_id)
     VALUES ($1, 'suspension', $2::date, $3, $4::bigint, $5, $6::bigint,
             $7::bigint, NULL, $8::bigint, $9, NULL, $10)
     RETURNING id`,
    [
      memberId,
      today,
      shares,
      nav.net_assets.toString(),
      nav.shares_outstanding,
      nav.nav_per_share.toString(),
      capital.toString(),
      escrow.toString(),
      JSON.stringify({ principal_paisa: principal.toString(), fines_paisa: fines.toString() }),
      proposal.id,
    ],
  );
  const snapshotId = (snapshotRes.rows[0] as { id: string }).id;

  return serialised({
    member_id: memberId,
    previous_status: beforeRow.status,
    suspended_on: today,
    snapshot_id: snapshotId,
  });
};

export const reinstatementExecutor: ExecutorSignature = async (db, proposal, _input, actor, _ctx, deps) => {
  const payload = proposal.payload as { member_id: string; terms?: string };
  const memberId = payload.member_id;
  const today = deps.clock.todayDhaka();

  const memberRes = await db.query(
    `SELECT status, suspended_on FROM members WHERE id = $1`,
    [memberId],
  );
  const member = memberRes.rows[0] as { status: string; suspended_on: string | null } | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');
  if (member.status !== 'suspended') {
    throw badRequest('member.not_suspended', 'Only a suspended member can be reinstated');
  }
  if (!member.suspended_on) {
    throw badRequest('member.no_suspension_date', 'Suspended member has no suspended_on date');
  }

  await db.query(
    `UPDATE members SET status = 'active' WHERE id = $1`,
    [memberId],
  );
  await db.query(
    `INSERT INTO member_status_events (member_id, from_status, to_status, reason, proposal_id, created_by)
     VALUES ($1, 'suspended', 'active', $2, $3, $4)`,
    [memberId, payload.terms ?? null, proposal.id, actor.id],
  );

  let fromPeriod = addMonths(member.suspended_on.slice(0, 7), 1);
  const currentPeriod = today.slice(0, 7);
  const catchUpPeriods: string[] = [];

  while (fromPeriod <= currentPeriod) {
    const first = periodStart(fromPeriod);
    const dueDay = await ruleInt(db, 'due_day', first);
    const dueDate = dateInPeriod(fromPeriod, dueDay);
    const sharesRes = await db.query(`SELECT shares_on($1::uuid, $2::date) AS shares`, [memberId, first]);
    const shares = Number((sharesRes.rows[0] as { shares: number }).shares);

    if (shares > 0) {
      const perShare = await rulePaisa(db, 'monthly_due_per_share_paisa', first);
      const amount = BigInt(shares) * perShare;
      const dueRes = await db.query(
        `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
         VALUES ($1, $2, 'monthly', $3, $4::bigint, $5::date)
         ON CONFLICT (member_id, period, kind) DO NOTHING
         RETURNING id`,
        [memberId, fromPeriod, shares, amount.toString(), dueDate],
      );
      if ((dueRes.rowCount ?? 0) > 0) {
        catchUpPeriods.push(fromPeriod);
        const dueId = (dueRes.rows[0] as { id: string }).id;

        const chargesFines = await ruleBool(db, 'reinstatement_charges_fines', first);
        if (chargesFines && dueDate < today) {
          const finePerShare = await rulePaisa(db, 'fine_per_share_paisa', first);
          const fineAmount = BigInt(shares) * finePerShare;
          await db.query(
            `INSERT INTO fines (due_id, member_id, amount_paisa, reason)
             VALUES ($1, $2, $3::bigint, 'reinstatement_catch_up')
             ON CONFLICT (due_id) DO NOTHING`,
            [dueId, memberId, fineAmount.toString()],
          );
        }
      }
    }
    const next = addMonths(fromPeriod, 1);
    if (next === fromPeriod) break;
    fromPeriod = next;
  }

  return serialised({
    member_id: memberId,
    reinstated_on: today,
    catch_up_periods: catchUpPeriods,
  });
};

export const settlementExecutor: ExecutorSignature = async (db, proposal, _input, actor, ctx, deps) => {
  const payload = proposal.payload as {
    member_id: string;
    kind: 'early_exit' | 'compassionate_exit' | 'inactive_return' | 'death_surrender' | 'wind_up';
    payout_plan: Array<{ due_on: string; amount_paisa: string }>;
  };
  const memberId = payload.member_id;
  const today = deps.clock.todayDhaka();

  const memberRes = await db.query(
    `SELECT m.status, m.suspended_on, u.id AS user_id
     FROM members m JOIN users u ON u.member_id = m.id WHERE m.id = $1`,
    [memberId],
  );
  const member = memberRes.rows[0] as { status: string; suspended_on: string | null; user_id: string } | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');

  const sharesRes = await db.query(`SELECT shares_on($1::uuid, $2::date) AS shares`, [memberId, today]);
  const shares = Number((sharesRes.rows[0] as { shares: number }).shares);
  const nav = await computeNav(db, today);
  const paidInCapital = await memberAccountBalance(db, 'MEMBER_CAPITAL', memberId);
  const escrow = await memberEscrow(db, memberId);
  const principal = await memberOutstandingPrincipal(db, memberId);
  const fines = await memberOutstandingFines(db, memberId);

  let gross: bigint;
  let serviceFee = 0n;
  if (payload.kind === 'early_exit') {
    const pct = await ruleInt(db, 'early_exit_service_charge_percent', today);
    serviceFee = divRound(paidInCapital * BigInt(pct), 100n);
    gross = paidInCapital;
  } else if (payload.kind === 'compassionate_exit' || payload.kind === 'inactive_return') {
    gross = paidInCapital;
  } else {
    // death_surrender and wind_up use NAV-based gross.
    gross = nav.shares_outstanding > 0 ? divRound(BigInt(shares) * nav.net_assets, BigInt(nav.shares_outstanding)) : 0n;
  }

  const deductions = principal + fines + serviceFee;
  const net = gross + escrow - deductions;

  if (net < 0n) {
    throw badRequest(
      'settlement.shortfall',
      'Net settlement is negative; pay the shortfall or reduce deductions first',
      { net_paisa: net.toString() },
    );
  }

  const planned = payload.payout_plan.reduce((sum, p) => sum + toBigInt(p.amount_paisa), 0n);
  if (planned !== net) {
    throw badRequest('settlement.payout_mismatch', 'Payout plan total must equal the net settlement');
  }

  const capitalPost = gross - deductions;
  const ledgerEntries: import('../../ledger/service').PostingInput[] = [];
  if (capitalPost > 0n) {
    ledgerEntries.push(
      proposalPosting(proposal.id, today, 'MEMBER_CAPITAL', 'SETTLEMENT_PAYABLE', capitalPost, `Settlement gross for ${payload.kind}`, memberId),
    );
  }
  if (escrow > 0n) {
    ledgerEntries.push(
      proposalPosting(proposal.id, today, 'MEMBER_ESCROW', 'SETTLEMENT_PAYABLE', escrow, `Settlement escrow release`, memberId),
    );
  }

  const ledgerSeqs: string[] = [];
  if (ledgerEntries.length > 0) {
    const posted = await postEntries(db as import('pg').PoolClient, ledgerEntries, ledgerActor(actor, ctx));
    ledgerSeqs.push(...posted.map((e) => e.seq.toString()));
  }

  await db.query(
    `UPDATE share_holdings
     SET effective_to = $1::date
     WHERE member_id = $2 AND effective_to IS NULL AND effective_from <= $1::date`,
    [today, memberId],
  );

  const snapshotRes = await db.query(
    `INSERT INTO member_snapshots
       (member_id, kind, taken_on, shares, net_assets_paisa, shares_outstanding, nav_per_share_paisa,
        paid_in_capital_paisa, gross_paisa, escrow_paisa, deductions, net_paisa, proposal_id)
     VALUES ($1, 'settlement_quote', $2::date, $3, $4::bigint, $5, $6::bigint,
             $7::bigint, $8::bigint, $9::bigint, $10, $11::bigint, $12)
     RETURNING id`,
    [
      memberId,
      today,
      shares,
      nav.net_assets.toString(),
      nav.shares_outstanding,
      nav.nav_per_share.toString(),
      paidInCapital.toString(),
      gross.toString(),
      escrow.toString(),
      JSON.stringify({ principal_paisa: principal.toString(), fines_paisa: fines.toString(), service_fee_paisa: serviceFee.toString() }),
      net.toString(),
      proposal.id,
    ],
  );
  const snapshotId = (snapshotRes.rows[0] as { id: string }).id;

  const settlementRes = await db.query(
    `INSERT INTO settlements (member_id, snapshot_id, proposal_id, kind, net_paisa, payout_plan, status)
     VALUES ($1, $2, $3, $4, $5::bigint, $6, 'approved')
     RETURNING id`,
    [
      memberId,
      snapshotId,
      proposal.id,
      payload.kind,
      net.toString(),
      JSON.stringify(payload.payout_plan),
    ],
  );
  const settlementId = (settlementRes.rows[0] as { id: string }).id;

  for (const item of payload.payout_plan) {
    await db.query(
      `INSERT INTO settlement_payouts (settlement_id, due_on, amount_paisa)
       VALUES ($1, $2::date, $3::bigint)`,
      [settlementId, item.due_on, toBigInt(item.amount_paisa).toString()],
    );
  }

  return serialised({
    settlement_id: settlementId,
    snapshot_id: snapshotId,
    member_id: memberId,
    kind: payload.kind,
    gross_paisa: gross.toString(),
    escrow_paisa: escrow.toString(),
    deductions_paisa: deductions.toString(),
    net_paisa: net.toString(),
    ledger_seqs: ledgerSeqs,
  });
};

export const memberDeceasedExecutor: ExecutorSignature = async (db, proposal, _input, actor, _ctx, deps) => {
  const payload = proposal.payload as { member_id: string; nominee_name: string; nominee_relation?: string };
  const memberId = payload.member_id;
  const today = deps.clock.todayDhaka();

  const beforeRes = await db.query(`SELECT status FROM members WHERE id = $1`, [memberId]);
  const beforeRow = beforeRes.rows[0] as { status: string } | undefined;
  if (!beforeRow) throw notFound('member.not_found', 'Member not found');
  if (beforeRow.status === 'deceased') throw conflict('member.already_deceased', 'Member is already marked deceased');

  await db.query(`UPDATE members SET status = 'deceased' WHERE id = $1`, [memberId]);
  await db.query(
    `INSERT INTO member_status_events (member_id, from_status, to_status, reason, proposal_id, created_by)
     VALUES ($1, $2, 'deceased', $3, $4, $5)`,
    [memberId, beforeRow.status, `Nominee: ${payload.nominee_name}${payload.nominee_relation ? ` (${payload.nominee_relation})` : ''}`, proposal.id, actor.id],
  );

  return serialised({
    member_id: memberId,
    previous_status: beforeRow.status,
    marked_deceased_on: today,
    note: 'Settlement flow to be completed separately.',
  });
};
