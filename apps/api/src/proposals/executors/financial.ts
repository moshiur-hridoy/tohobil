import { divRound, type CashAccountCode } from '@barakah/shared';
import { postEntries } from '../../ledger/service';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { accountBalance, computeNav } from '../../lib/nav';
import { toBigInt } from '../../lib/money';
import { ledgerActor, proposalPosting, requireAmount, serialised, sourceAccount } from './shared';
import type { ExecutorSignature } from './shared';

export const fineWaiverExecutor: ExecutorSignature = async (db, proposal) => {
  const payload = proposal.payload as { fine_ids: string[]; reason: string };
  const fineIds = payload.fine_ids;
  const rows = (await db.query(
    `SELECT id, member_id, waived_at FROM fines WHERE id = ANY($1)`,
    [fineIds],
  )).rows as Array<{ id: string; member_id: string; waived_at: Date | null }>;

  if (rows.length !== fineIds.length) {
    throw badRequest('proposal.fine_not_found', 'One or more referenced fines do not exist');
  }
  const already = rows.find((r) => r.waived_at !== null);
  if (already) throw badRequest('proposal.fine_already_waived', `Fine ${already.id} is already waived`);

  await db.query(
    `UPDATE fines
     SET waived_by_proposal = $1, waived_at = now()
     WHERE id = ANY($2)`,
    [proposal.id, fineIds],
  );

  return serialised({
    waived_count: rows.length,
    member_id: rows[0]!.member_id,
    fine_ids: fineIds,
  });
};

export const expenseExecutor: ExecutorSignature = async (db, proposal, input, actor, ctx, deps) => {
  const payload = proposal.payload as {
    max_amount_paisa: string;
    account: 'MAINTENANCE' | 'OTHER_EXPENSE';
    payee: string;
    purpose: string;
  };
  const actual = requireAmount(input);
  const max = toBigInt(payload.max_amount_paisa);
  if (actual > max) {
    throw badRequest('proposal.amount_exceeds_approved', 'Actual amount exceeds the approved maximum');
  }

  const source = sourceAccount(input);
  const posted = await postEntries(
    db as import('pg').PoolClient,
    [
      proposalPosting(
        proposal.id,
        deps.clock.todayDhaka(),
        payload.account,
        source,
        actual,
        `Expense: ${payload.purpose} to ${payload.payee}${input.note ? ` - ${input.note}` : ''}`,
      ),
    ],
    ledgerActor(actor, ctx),
  );

  return serialised({
    expense_account: payload.account,
    source_account: source,
    amount_paisa: actual.toString(),
    ledger_seqs: posted.map((e) => e.seq.toString()),
  });
};

export const charityDonationExecutor: ExecutorSignature = async (db, proposal, input, actor, ctx, deps) => {
  const payload = proposal.payload as {
    recipient: string;
    amount_paisa: string;
    purpose: string;
  };
  const amount = toBigInt(payload.amount_paisa);
  const proofFileId = input.proof_file_id;
  if (!proofFileId) {
    throw badRequest('proposal.proof_required', 'A charity donation requires a proof receipt file');
  }

  const charityBalance = await accountBalance(db, 'CHARITY_PAYABLE');
  if (charityBalance < amount) {
    throw forbidden(
      'charity.insufficient_balance',
      `Charity balance ${charityBalance.toString()} is less than donation ${amount.toString()}`,
    );
  }

  const source = sourceAccount(input);
  const posted = await postEntries(
    db as import('pg').PoolClient,
    [
      proposalPosting(
        proposal.id,
        deps.clock.todayDhaka(),
        'CHARITY_PAYABLE',
        source,
        amount,
        `Donation to ${payload.recipient}: ${payload.purpose}`,
      ),
    ],
    ledgerActor(actor, ctx),
  );
  const seq = posted[0]!.seq;

  const donationRes = await db.query(
    `INSERT INTO charity_donations (proposal_id, recipient, amount_paisa, proof_file_id, donated_on, ledger_seq)
     VALUES ($1, $2, $3::bigint, $4, $5::date, $6::bigint)
     RETURNING id`,
    [proposal.id, payload.recipient, amount.toString(), proofFileId, deps.clock.todayDhaka(), seq.toString()],
  );
  const donationId = (donationRes.rows[0] as { id: string }).id;

  return serialised({
    donation_id: donationId,
    amount_paisa: amount.toString(),
    ledger_seq: seq.toString(),
  });
};

export const investmentPurchaseExecutor: ExecutorSignature = async (db, proposal, input, actor, ctx, deps) => {
  const payload = proposal.payload as {
    kind: 'gold' | 'land' | 'house' | 'other';
    name: string;
    max_amount_paisa: string;
    quantity?: number;
    unit?: 'vori' | 'gram';
    source_account: CashAccountCode;
    notes?: string;
    compliance: Record<string, unknown>;
    feasibility_file_id?: string;
    partner_id?: string;
  };
  const actual = requireAmount(input);
  const max = toBigInt(payload.max_amount_paisa);
  if (actual > max) {
    throw badRequest('proposal.amount_exceeds_approved', 'Actual cost exceeds the approved maximum');
  }

  const status = payload.kind === 'land' || payload.kind === 'house' ? 'acquiring' : 'held';
  const today = deps.clock.todayDhaka();
  if (payload.partner_id) {
    const partner = await db.query(`SELECT kind FROM investment_partners WHERE id = $1`, [payload.partner_id]);
    if (partner.rowCount === 0) throw notFound('partner.not_found', 'Investment partner not found');
    if ((partner.rows[0] as { kind: string }).kind !== payload.kind) {
      throw badRequest('partner.kind_mismatch', 'The purchase is of a different kind than this partner');
    }
  }

  const assetRes = await db.query(
    `INSERT INTO assets
       (kind, name, description, cost_paisa, quantity, unit, status, acquired_on, proposal_id, feasibility_file_id, compliance, partner_id)
     VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8::date, $9, $10, $11, $12)
     RETURNING id`,
    [
      payload.kind,
      payload.name,
      payload.notes ?? null,
      actual.toString(),
      payload.quantity ?? null,
      payload.unit ?? null,
      status,
      today,
      proposal.id,
      payload.feasibility_file_id ?? null,
      JSON.stringify(payload.compliance),
      payload.partner_id ?? null,
    ],
  );
  const assetId = (assetRes.rows[0] as { id: string }).id;

  const ledgerSeqs: string[] = [];
  if (actual > 0n) {
    const source = input.account ?? payload.source_account;
    const posted = await postEntries(
      db as import('pg').PoolClient,
      [
        proposalPosting(
          proposal.id,
          today,
          'INVESTMENTS_AT_COST',
          source,
          actual,
          `Purchase: ${payload.name}`,
        ),
      ],
      ledgerActor(actor, ctx),
    );
    ledgerSeqs.push(...posted.map((e) => e.seq.toString()));
  }

  return serialised({
    asset_id: assetId,
    status,
    amount_paisa: actual.toString(),
    ledger_seqs: ledgerSeqs,
  });
};

export const assetSaleExecutor: ExecutorSignature = async (db, proposal, input, actor, ctx, deps) => {
  const payload = proposal.payload as { asset_id: string; min_price_paisa: string };
  const price = requireAmount(input);
  const minPrice = toBigInt(payload.min_price_paisa);
  if (price < minPrice) {
    throw badRequest('proposal.price_below_min', 'Sale price is below the approved minimum');
  }

  const assetRes = await db.query(`SELECT id, cost_paisa::text, status FROM assets WHERE id = $1`, [
    payload.asset_id,
  ]);
  const asset = assetRes.rows[0] as { id: string; cost_paisa: string; status: string } | undefined;
  if (!asset) throw notFound('asset.not_found', 'Asset not found');
  if (asset.status === 'sold') throw badRequest('asset.already_sold', 'This asset has already been sold');

  const cost = toBigInt(asset.cost_paisa);
  const source = sourceAccount(input);
  const today = deps.clock.todayDhaka();
  const entries: import('../../ledger/service').PostingInput[] = [];

  if (price >= cost) {
    entries.push(
      proposalPosting(proposal.id, today, source, 'INVESTMENTS_AT_COST', cost, `Sale of ${asset.id}: cost recovery`),
      proposalPosting(proposal.id, today, source, 'ASSET_GAIN', price - cost, `Sale of ${asset.id}: gain`),
    );
  } else {
    entries.push(
      proposalPosting(proposal.id, today, source, 'INVESTMENTS_AT_COST', price, `Sale of ${asset.id}: proceeds`),
      proposalPosting(proposal.id, today, 'ASSET_LOSS', 'INVESTMENTS_AT_COST', cost - price, `Sale of ${asset.id}: loss`),
    );
  }

  const posted = await postEntries(db as import('pg').PoolClient, entries, ledgerActor(actor, ctx));

  await db.query(
    `UPDATE assets
     SET status = 'sold', sold_on = $2::date, sale_price_paisa = $3::bigint
     WHERE id = $1`,
    [asset.id, today, price.toString()],
  );

  return serialised({
    asset_id: asset.id,
    sale_price_paisa: price.toString(),
    cost_paisa: cost.toString(),
    ledger_seqs: posted.map((e) => e.seq.toString()),
  });
};

interface DistributionMember {
  member_id: string;
  status: string;
  shares: number;
  portion: bigint;
}

export const distributionExecutor: ExecutorSignature = async (db, proposal, input, actor, ctx, deps) => {
  const payload = proposal.payload as { total_paisa: string; source_account: CashAccountCode };
  const total = toBigInt(payload.total_paisa);
  const sourceAccount = input.account ?? payload.source_account;
  const today = deps.clock.todayDhaka();

  const nav = await computeNav(db, today);
  const rows = (await db.query(
    `SELECT m.id, m.status, shares_on(m.id, $1::date) AS shares
     FROM members m
     WHERE m.status IN ('active','warning','suspended','deceased')
       AND shares_on(m.id, $1::date) > 0
     ORDER BY m.code`,
    [today],
  )).rows as Array<{ id: string; status: string; shares: number }>;

  if (nav.shares_outstanding === 0) {
    throw badRequest('distribution.no_shares', 'No shares outstanding to distribute against');
  }

  const members: DistributionMember[] = rows.map((r) => ({
    member_id: r.id,
    status: r.status,
    shares: Number(r.shares),
    portion: divRound(total * BigInt(r.shares), BigInt(nav.shares_outstanding)),
  }));

  const sum = members.reduce((acc, m) => acc + m.portion, 0n);
  const remainder = total - sum;
  if (members.length > 0) {
    members[members.length - 1]!.portion += remainder;
  }

  const entries: import('../../ledger/service').PostingInput[] = [];
  for (const m of members) {
    if (m.portion <= 0n) continue;
    const credit = m.status === 'suspended' ? 'MEMBER_ESCROW' : sourceAccount;
    entries.push(
      proposalPosting(
        proposal.id,
        today,
        'DISTRIBUTIONS',
        credit,
        m.portion,
        `Distribution by shares (${m.shares})`,
        m.status === 'suspended' ? m.member_id : null,
      ),
    );
  }

  const ledgerSeqs: string[] = [];
  if (entries.length > 0) {
    const posted = await postEntries(db as import('pg').PoolClient, entries, ledgerActor(actor, ctx));
    ledgerSeqs.push(...posted.map((e) => e.seq.toString()));
  }

  return serialised({
    total_paisa: total.toString(),
    source_account: sourceAccount,
    portions: members.map((m) => ({
      member_id: m.member_id,
      status: m.status,
      shares: m.shares,
      amount_paisa: m.portion.toString(),
    })),
    ledger_seqs: ledgerSeqs,
  });
};
