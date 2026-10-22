import type pg from 'pg';
import { methodAccount, type Clock } from '@barakah/shared';
import { LEDGER_REF, postEntries, type PostedEntry } from '../ledger/service';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { paisaOut, toBigInt } from '../lib/money';
import type { Db } from '../lib/tx';

export interface CharityDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface ClientCtx {
  userId: string;
  ip?: string | undefined;
  deviceId?: string | null | undefined;
}

interface DonationRow {
  id: string;
  proposal_id: string;
  recipient: string;
  amount_paisa: string | bigint;
  donated_on: string;
  proof_file_id: string | null;
  ledger_seq: string | bigint | null;
}

export interface CharityDonationListItem {
  id: string;
  proposal_id: string;
  recipient: string;
  amount_paisa: string;
  donated_on: string;
  proof_file_id: string | null;
  ledger_seq: string | null;
}

/** Donations made, optionally filtered by date range. */
export async function listCharityDonations(
  db: Db,
  from?: string,
  to?: string,
): Promise<{ items: CharityDonationListItem[] }> {
  const res = await db.query(
    `SELECT c.id, c.proposal_id, c.recipient, c.amount_paisa, c.donated_on::text AS donated_on,
            c.proof_file_id, c.ledger_seq
     FROM charity_donations c
     WHERE ($1::date IS NULL OR c.donated_on >= $1::date)
       AND ($2::date IS NULL OR c.donated_on <= $2::date)
     ORDER BY c.donated_on DESC, c.id DESC`,
    [from ?? null, to ?? null],
  );
  const rows = res.rows as DonationRow[];
  return {
    items: rows.map((r) => ({
      id: r.id,
      proposal_id: r.proposal_id,
      recipient: r.recipient,
      amount_paisa: paisaOut(r.amount_paisa),
      donated_on: r.donated_on,
      proof_file_id: r.proof_file_id,
      ledger_seq: r.ledger_seq === null ? null : String(r.ledger_seq),
    })),
  };
}

/** Sum of ledger rows whose credit_account is CHARITY_PAYABLE (inflows) within a date range. */
async function charityReceipts(db: Db, from: string, to: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(amount_paisa), 0) AS total
     FROM ledger_entries
     WHERE credit_account = 'CHARITY_PAYABLE' AND entry_date BETWEEN $1::date AND $2::date`,
    [from, to],
  );
  return toBigInt((res.rows[0] as { total: unknown }).total);
}

/** Sum of ledger rows whose debit_account is CHARITY_PAYABLE (outflows) within a date range. */
async function charityDisbursements(db: Db, from: string, to: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(amount_paisa), 0) AS total
     FROM ledger_entries
     WHERE debit_account = 'CHARITY_PAYABLE' AND entry_date BETWEEN $1::date AND $2::date`,
    [from, to],
  );
  return toBigInt((res.rows[0] as { total: unknown }).total);
}

/** Natural balance of CHARITY_PAYABLE before the first day of a year. */
async function charityOpeningBalance(db: Db, year: string): Promise<bigint> {
  const before = `${year}-01-01`;
  const res = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN credit_account = 'CHARITY_PAYABLE' THEN amount_paisa ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN debit_account = 'CHARITY_PAYABLE' THEN amount_paisa ELSE 0 END), 0)
       AS balance
     FROM ledger_entries WHERE entry_date < $1::date`,
    [before],
  );
  return toBigInt((res.rows[0] as { balance: unknown }).balance);
}

/** The fund's own running costs (not charity money); listed on their own tab beside charity. */
export const FUND_EXPENSE_ACCOUNTS = ['BANK_CHARGE', 'SMS_CHARGE', 'MAINTENANCE', 'OTHER_EXPENSE'] as const;

export type CharityEntryKind = 'fine' | 'bank_profit' | 'donation' | 'reversal' | 'other';

export interface CharityEntry {
  seq: string;
  entry_date: string;
  direction: 'in' | 'out';
  kind: CharityEntryKind;
  amount_paisa: string;
  member_code: string | null;
  member_name: string | null;
  /** Recipient of a donation recorded through a proposal, when there is one. */
  recipient: string | null;
  memo: string | null;
}

export interface FundExpenseEntry {
  seq: string;
  entry_date: string;
  account: string;
  /** Negative for a reversal (money back into the fund). */
  amount_paisa: string;
  memo: string | null;
  /** Moved onto the levy fund; no longer a cost of the main fund. */
  moved: boolean;
}

interface CharityEntryRow {
  seq: string | bigint;
  entry_date: string;
  debit_account: string;
  amount_paisa: string | bigint;
  ref_type: string | null;
  reverses_seq: string | bigint | null;
  member_code: string | null;
  member_name: string | null;
  recipient: string | null;
  memo: string | null;
}

function entryKind(r: CharityEntryRow, direction: 'in' | 'out'): CharityEntryKind {
  if (r.reverses_seq !== null) return 'reversal';
  if (direction === 'out') return 'donation';
  if (r.ref_type === LEDGER_REF.ribaReceived) return 'bank_profit';
  // Member money into charity is a fine (or absence fine) paid with a payment (18.2).
  if (r.member_code !== null) return 'fine';
  return 'other';
}

/** Every CHARITY_PAYABLE movement in a date range, oldest first: where the money came from and went. */
async function charityEntries(db: Db, from: string, to: string): Promise<CharityEntry[]> {
  const res = await db.query(
    `SELECT e.seq, e.entry_date::text AS entry_date, e.debit_account, e.amount_paisa, e.ref_type,
            e.reverses_seq, m.code AS member_code, m.full_name AS member_name, c.recipient, e.memo
     FROM ledger_entries e
     LEFT JOIN members m ON m.id = e.member_id
     LEFT JOIN charity_donations c ON c.ledger_seq = e.seq
     WHERE 'CHARITY_PAYABLE' IN (e.debit_account, e.credit_account)
       AND e.entry_date BETWEEN $1::date AND $2::date
     ORDER BY e.entry_date, e.seq`,
    [from, to],
  );
  return (res.rows as CharityEntryRow[]).map((r) => {
    const direction = r.debit_account === 'CHARITY_PAYABLE' ? 'out' : 'in';
    return {
      seq: String(r.seq),
      entry_date: r.entry_date,
      direction,
      kind: entryKind(r, direction),
      amount_paisa: paisaOut(r.amount_paisa),
      member_code: r.member_code,
      member_name: r.member_name,
      recipient: r.recipient,
      memo: r.memo,
    };
  });
}

/**
 * Every expense of the fund's own, oldest first, with the total; a reversal counts negative. A charge
 * moved onto the levy fund (ASSUMPTIONS 106) is marked `moved` and left out of the total, and the
 * moving entry itself is not listed here: it belongs to the levy fund.
 */
export async function listFundExpenses(db: Db): Promise<{ total_paisa: string; items: FundExpenseEntry[] }> {
  const res = await db.query(
    `SELECT e.seq, e.entry_date::text AS entry_date,
            CASE WHEN e.debit_account = ANY($1::text[]) THEN e.debit_account ELSE e.credit_account END AS account,
            CASE WHEN e.debit_account = ANY($1::text[]) THEN e.amount_paisa ELSE -e.amount_paisa END AS amount_paisa,
            e.memo,
            EXISTS (SELECT 1 FROM levy_expenses x WHERE x.moved_from_seq = e.seq) AS moved
     FROM ledger_entries e
     WHERE (e.debit_account = ANY($1::text[]) OR e.credit_account = ANY($1::text[]))
       AND e.ref_type IS DISTINCT FROM 'levy_moved'
     ORDER BY e.entry_date, e.seq`,
    [FUND_EXPENSE_ACCOUNTS],
  );
  const items = (res.rows as Array<{ seq: string | bigint; entry_date: string; account: string; amount_paisa: string | bigint; memo: string | null; moved: boolean }>).map((r) => ({
    seq: String(r.seq),
    entry_date: r.entry_date,
    account: r.account,
    amount_paisa: paisaOut(r.amount_paisa),
    memo: r.memo,
    moved: r.moved,
  }));
  const total = items.filter((e) => !e.moved).reduce((sum, e) => sum + BigInt(e.amount_paisa), 0n);
  return { total_paisa: total.toString(), items };
}

export interface CharityStatementResult {
  /** `null`: the whole history. */
  year: string | null;
  opening_paisa: string;
  receipts_paisa: string;
  disbursements_paisa: string;
  closing_paisa: string;
  entries: CharityEntry[];
}

/**
 * Aggregated charity receipts and disbursements for a calendar year with opening and closing
 * CHARITY_PAYABLE balance (spec 18.2) and each movement behind them. Without a year it covers the
 * whole history, so the opening balance is zero.
 */
export async function charityStatement(db: Db, year?: string): Promise<CharityStatementResult> {
  const from = year ? `${year}-01-01` : '0001-01-01';
  const to = year ? `${year}-12-31` : '9999-12-31';
  const [opening, receipts, disbursements, entries] = await Promise.all([
    year ? charityOpeningBalance(db, year) : Promise.resolve(0n),
    charityReceipts(db, from, to),
    charityDisbursements(db, from, to),
    charityEntries(db, from, to),
  ]);
  const closing = opening + receipts - disbursements;
  return {
    year: year ?? null,
    opening_paisa: opening.toString(),
    receipts_paisa: receipts.toString(),
    disbursements_paisa: disbursements.toString(),
    closing_paisa: closing.toString(),
    entries,
  };
}

interface CharityProposal {
  id: string;
  status: string;
  payload: Record<string, unknown>;
}

async function loadCharityProposal(db: Db, proposalId: string): Promise<CharityProposal> {
  const res = await db.query<CharityProposal>(
    `SELECT id, status, payload FROM proposals WHERE id = $1 AND type = 'charity_donation'`,
    [proposalId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('charity.proposal_not_found', 'Charity donation proposal not found');
  return row;
}

/**
 * Record a donation receipt and post the outflow from CHARITY_PAYABLE (spec 18.2).
 * Called when a `charity_donation` proposal is executed, or later when the actual receipt arrives.
 *
 * - The actual amount may not exceed the proposal's approved amount.
 * - A proof file is required unless the caller explicitly opts out (not recommended).
 */
export async function recordDonationReceipt(
  db: Db,
  deps: CharityDeps,
  input: {
    proposal_id: string;
    actual_amount_paisa: bigint;
    method: 'bkash' | 'nagad' | 'bank' | 'cash' | 'other';
    note?: string | null;
    proof_file_id?: string | null;
    actor: ClientCtx;
  },
): Promise<{ donation_id: string; ledger_seq: string }> {
  const proposal = await loadCharityProposal(db, input.proposal_id);
  if (proposal.status !== 'approved' && proposal.status !== 'executed') {
    throw badRequest('charity.not_approved', 'Donation proposal must be approved or executed');
  }

  const approvedRaw = (proposal.payload as Record<string, unknown>).amount_paisa;
  const approved = typeof approvedRaw === 'string' ? BigInt(approvedRaw) : toBigInt(approvedRaw ?? 0);
  if (input.actual_amount_paisa > approved) {
    throw badRequest('charity.exceeds_approved', 'Donation amount exceeds the approved amount');
  }

  const existing = await db.query(
    `SELECT COALESCE(SUM(amount_paisa), 0) AS total
     FROM charity_donations WHERE proposal_id = $1`,
    [input.proposal_id],
  );
  const alreadyDonated = toBigInt((existing.rows[0] as { total: unknown }).total);
  if (alreadyDonated + input.actual_amount_paisa > approved) {
    throw badRequest('charity.exceeds_approved', 'Cumulative donations exceed the approved amount');
  }

  const donatedOn = deps.clock.todayDhaka();

  // Post the ledger entry first; charity_donations is append-only, so the seq is written on insert.
  const [entry] = await postEntries(
    db,
    [
      {
        entry_date: donatedOn,
        debit: 'CHARITY_PAYABLE',
        credit: methodAccount(input.method),
        amount_paisa: input.actual_amount_paisa,
        member_id: null,
        ref_type: LEDGER_REF.charityDonation,
        ref_id: input.proposal_id,
        memo: input.note ?? `Charity donation: ${(proposal.payload as Record<string, unknown>).recipient ?? ''}`,
      },
    ],
    {
      userId: input.actor.userId,
      ip: input.actor.ip,
      deviceId: input.actor.deviceId,
    },
  );
  const posted = entry as PostedEntry;

  const donation = await db.query(
    `INSERT INTO charity_donations (proposal_id, recipient, amount_paisa, proof_file_id, donated_on, ledger_seq)
     VALUES ($1, $2, $3::bigint, $4, $5::date, $6::bigint)
     RETURNING id`,
    [
      input.proposal_id,
      (proposal.payload as Record<string, unknown>).recipient ?? 'Unknown',
      input.actual_amount_paisa.toString(),
      input.proof_file_id ?? null,
      donatedOn,
      posted.seq.toString(),
    ],
  );
  const donationId = (donation.rows[0] as { id: string }).id;

  // Mark proposal executed on first donation if it is not already.
  if (proposal.status === 'approved') {
    await db.query(
      `UPDATE proposals SET status = 'executed', executed_at = now(), executed_by = $2,
                          result_ref = jsonb_build_object('donation_id', $3::text, 'amount_paisa', $4::text)
       WHERE id = $1`,
      [input.proposal_id, input.actor.userId, donationId, input.actual_amount_paisa.toString()],
    );
  }

  await audit(db, {
    actor: input.actor.userId,
    action: 'charity.donation_recorded',
    entityType: 'charity_donation',
    entityId: donationId,
    after: {
      proposal_id: input.proposal_id,
      amount_paisa: input.actual_amount_paisa.toString(),
      method: input.method,
      donated_on: donatedOn,
      ledger_seq: posted.seq.toString(),
    },
    ip: input.actor.ip,
    deviceId: input.actor.deviceId,
  });

  return { donation_id: donationId, ledger_seq: posted.seq.toString() };
}
