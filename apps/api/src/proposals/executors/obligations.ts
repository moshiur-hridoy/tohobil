import { divRound, type CashAccountCode } from '@barakah/shared';
import { postEntries } from '../../ledger/service';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { memberAccountBalance } from '../../lib/nav';
import { toBigInt } from '../../lib/money';
import { ledgerActor, proposalPosting, serialised } from './shared';
import type { ExecutorSignature } from './shared';

/**
 * Executors for the constitution's money obligations (spec 18.7): levies, interest-free member loans
 * to the fund (qard), deferred purchases, and winding up. None of them lends money to a member.
 */

/** Levy dues for every active member in proportion to shares (6.2). Levy is never capital and never NAV. */
export const assetCostLevyExecutor: ExecutorSignature = async (db, proposal, _input, _actor, _ctx, deps) => {
  const payload = proposal.payload as { total_paisa: string; asset_id?: string; due_date: string; reason: string };
  const total = toBigInt(payload.total_paisa);
  const today = deps.clock.todayDhaka();
  const period = payload.due_date.slice(0, 7);

  const members = (
    await db.query(
      `SELECT m.id, m.code, shares_on(m.id, $1::date) AS shares
       FROM members m
       WHERE m.status IN ('active','warning') AND shares_on(m.id, $1::date) > 0
       ORDER BY m.code`,
      [today],
    )
  ).rows as Array<{ id: string; code: string; shares: number }>;
  const totalShares = members.reduce((sum, m) => sum + Number(m.shares), 0);
  if (totalShares === 0) throw badRequest('levy.no_members', 'There are no active members to charge');

  const portions = members.map((m) => ({
    ...m,
    amount: divRound(total * BigInt(m.shares), BigInt(totalShares)),
  }));
  const remainder = total - portions.reduce((sum, p) => sum + p.amount, 0n);
  portions[portions.length - 1]!.amount += remainder;

  const clash = await db.query(
    `SELECT 1 FROM dues WHERE kind = 'levy' AND period = $1 LIMIT 1`,
    [period],
  );
  if ((clash.rowCount ?? 0) > 0) {
    throw conflict('levy.period_taken', `A levy is already due in ${period}; pick a due date in another month`);
  }
  for (const p of portions) {
    await db.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, $2, 'levy', $3, $4::bigint, $5::date)`,
      [p.id, period, p.shares, p.amount.toString(), payload.due_date],
    );
  }

  return serialised({
    total_paisa: total.toString(),
    period,
    due_date: payload.due_date,
    asset_id: payload.asset_id ?? null,
    members: portions.map((p) => ({ member_id: p.id, shares: Number(p.shares), amount_paisa: p.amount.toString() })),
  });
};

/**
 * Interest-free loan from a member to the fund (6.3). Receiving posts `DR <account>, CR MEMBER_QARD`;
 * repaying posts the reverse and can never exceed what that member has lent.
 */
export const memberQardExecutor: ExecutorSignature = async (db, proposal, input, actor, ctx, deps) => {
  const payload = proposal.payload as {
    direction: 'receive' | 'repay';
    lender_member_id: string;
    amount_paisa: string;
    account: CashAccountCode;
  };
  const amount = toBigInt(payload.amount_paisa);
  const account = input.account ?? payload.account;
  const lender = await db.query(`SELECT code FROM members WHERE id = $1`, [payload.lender_member_id]);
  if ((lender.rowCount ?? 0) === 0) throw notFound('member.not_found', 'Lender not found');

  if (payload.direction === 'repay') {
    const owed = await memberAccountBalance(db, 'MEMBER_QARD', payload.lender_member_id);
    if (amount > owed) {
      throw badRequest('qard.exceeds_balance', `The fund owes this member ${owed.toString()} paisa, not ${amount.toString()}`);
    }
  }
  const [debit, credit] = payload.direction === 'receive' ? [account, 'MEMBER_QARD'] : ['MEMBER_QARD', account];
  const posted = await postEntries(
    db as import('pg').PoolClient,
    [
      proposalPosting(
        proposal.id,
        deps.clock.todayDhaka(),
        debit,
        credit,
        amount,
        payload.direction === 'receive' ? 'Qard received from member' : 'Qard repaid to member',
        payload.lender_member_id,
      ),
    ],
    ledgerActor(actor, ctx),
  );
  return serialised({
    direction: payload.direction,
    lender_member_id: payload.lender_member_id,
    amount_paisa: amount.toString(),
    ledger_seqs: posted.map((e) => e.seq.toString()),
  });
};

/**
 * Deferred purchase or hire purchase through an interest-free bank (6.3). Records the arrangement and
 * its instalments and books the asset against `DEFERRED_PURCHASE_PAYABLE`; each instalment is paid
 * later from the cashier screen. The instalments must add up to the total, so no hidden charge.
 */
export const financingArrangementExecutor: ExecutorSignature = async (db, proposal, _input, actor, ctx, deps) => {
  const payload = proposal.payload as {
    asset_id: string;
    counterparty: string;
    description: string;
    total_paisa: string;
    instalments: Array<{ due_on: string; amount_paisa: string }>;
  };
  const total = toBigInt(payload.total_paisa);
  const sum = payload.instalments.reduce((s, i) => s + toBigInt(i.amount_paisa), 0n);
  if (sum !== total) {
    throw badRequest('financing.instalments_mismatch', `Instalments add up to ${sum.toString()}, not the total ${total.toString()}`);
  }
  const asset = await db.query(`SELECT status FROM assets WHERE id = $1 FOR UPDATE`, [payload.asset_id]);
  const status = (asset.rows[0] as { status: string } | undefined)?.status;
  if (!status) throw notFound('asset.not_found', 'Asset not found');
  if (status === 'sold') throw badRequest('asset.already_sold', 'This asset has already been sold');

  const arrangement = await db.query(
    `INSERT INTO financing_arrangements (proposal_id, asset_id, counterparty, description, total_paisa)
     VALUES ($1, $2, $3, $4, $5::bigint) RETURNING id`,
    [proposal.id, payload.asset_id, payload.counterparty, payload.description, total.toString()],
  );
  const arrangementId = (arrangement.rows[0] as { id: string }).id;
  for (const i of payload.instalments) {
    await db.query(
      `INSERT INTO financing_instalments (arrangement_id, due_on, amount_paisa) VALUES ($1, $2::date, $3::bigint)`,
      [arrangementId, i.due_on, i.amount_paisa],
    );
  }
  const posted = await postEntries(
    db as import('pg').PoolClient,
    [
      proposalPosting(
        proposal.id,
        deps.clock.todayDhaka(),
        'INVESTMENTS_AT_COST',
        'DEFERRED_PURCHASE_PAYABLE',
        total,
        `Deferred purchase: ${payload.counterparty}`,
      ),
    ],
    ledgerActor(actor, ctx),
  );
  await db.query(`UPDATE assets SET cost_paisa = cost_paisa + $2::bigint WHERE id = $1`, [payload.asset_id, total.toString()]);

  return serialised({
    arrangement_id: arrangementId,
    asset_id: payload.asset_id,
    total_paisa: total.toString(),
    ledger_seqs: posted.map((e) => e.seq.toString()),
  });
};

/**
 * Early dissolution (10): from now on no dues are generated and nobody new joins. Each asset is sold
 * by its own `asset_sale` proposal and each member is paid by a `settlement` of kind `wind_up`.
 */
export const windUpExecutor: ExecutorSignature = async (db, proposal, _input, actor, _ctx, deps) => {
  const payload = proposal.payload as { asset_ids_to_sell: string[]; distribution_plan: string };
  const existing = await db.query(`SELECT 1 FROM settings WHERE key = 'wind_up'`);
  if ((existing.rowCount ?? 0) > 0) throw conflict('wind_up.already_started', 'The fund is already being wound up');
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ('wind_up', $1::jsonb, $2)`,
    [
      JSON.stringify({
        proposal_id: proposal.id,
        since: deps.clock.todayDhaka(),
        asset_ids_to_sell: payload.asset_ids_to_sell,
        distribution_plan: payload.distribution_plan,
      }),
      actor.id,
    ],
  );
  return serialised({
    since: deps.clock.todayDhaka(),
    asset_ids_to_sell: payload.asset_ids_to_sell,
    distribution_plan: payload.distribution_plan,
    note: 'Dues generation and new members are stopped; sell assets and settle members through their own proposals.',
  });
};
