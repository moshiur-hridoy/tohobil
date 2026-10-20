import { ACCOUNT_CODES, isValidIsoDate, type Clock } from '@barakah/shared';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { toBigInt } from '../lib/money';
import type { Db } from '../lib/tx';

/**
 * Ledger posting service (spec 5.6). The only code that inserts into `ledger_entries`.
 *
 * Every row is one double-entry pair: a debit account, a credit account and one positive amount in
 * paisa (bigint). The database does the heavy lifting: a trigger chains the hashes (under an advisory
 * lock), refuses locked periods and the retired FINE_INCOME account, and checks that a reversal mirrors
 * its original. This module adds early, readable errors and keeps callers honest:
 *
 *  - always call it with the client of an open transaction, so the postings commit together with the
 *    business change that caused them (payment confirmed, rent received, ...);
 *  - the transaction must be READ COMMITTED (the default); the trigger refuses anything stricter;
 *  - never UPDATE or DELETE a ledger row. A correction is `reverseEntry`.
 */

/** Reference types the system writes. Callers may add their own; the pattern is `^[a-z_]{1,40}$`. */
export const LEDGER_REF = {
  payment: 'payment',
  paymentReversal: 'payment_reversal',
  autoCharge: 'auto_charge',
  ribaReceived: 'riba_received',
  rentReceipt: 'rent_receipt',
  proposal: 'proposal',
  settlementPayout: 'settlement_payout',
  escrowPayout: 'escrow_payout',
  charityDonation: 'charity_donation',
  import: 'import',
} as const;

/** `payment` -> `payment_reversal`, `rent_receipt` -> `rent_receipt_reversal`, none -> `reversal`. */
export function reversalRefType(refType: string | null): string {
  return refType ? `${refType}_reversal` : 'reversal';
}

export interface PostingInput {
  /** Business date, `YYYY-MM-DD` (Asia/Dhaka). Must not fall in a locked period. */
  entry_date: string;
  debit: string;
  credit: string;
  /** Positive paisa. */
  amount_paisa: bigint;
  member_id?: string | null;
  /** Required: every posting says what caused it. */
  ref_type: string;
  ref_id?: string | null;
  memo?: string | null;
  /** Set only by `reverseEntry`. */
  reverses_seq?: bigint | null;
}

export interface PostedEntry {
  seq: bigint;
  hash: string;
  entry_date: string;
  debit_account: string;
  credit_account: string;
  amount_paisa: bigint;
  member_id: string | null;
  ref_type: string;
  ref_id: string | null;
  memo: string | null;
  reverses_seq: bigint | null;
}

export interface LedgerActor {
  /** The user posting (stored as `created_by`); `null` for jobs and the CLI. */
  userId: string | null;
  ip?: string | undefined;
  deviceId?: string | null | undefined;
}

const ACCOUNTS: ReadonlySet<string> = new Set(ACCOUNT_CODES);
/** Rows stay for history, but accept no new postings (18.2). The database trigger enforces it too. */
const RETIRED_ACCOUNTS: ReadonlySet<string> = new Set(['FINE_INCOME']);
const REF_TYPE = /^[a-z_]{1,40}$/;
const MIN_REASON = 3;

function validate(p: PostingInput): void {
  if (typeof p.amount_paisa !== 'bigint' || p.amount_paisa <= 0n) {
    throw badRequest(
      'ledger.invalid_amount',
      'A posting amount must be a positive number of paisa',
    );
  }
  for (const account of [p.debit, p.credit]) {
    if (!ACCOUNTS.has(account)) {
      throw badRequest('ledger.unknown_account', `Unknown account ${account}`);
    }
    if (RETIRED_ACCOUNTS.has(account)) {
      throw badRequest(
        'ledger.retired_account',
        `${account} is retired: fines are charity money and post to CHARITY_PAYABLE`,
      );
    }
  }
  if (p.debit === p.credit) {
    throw badRequest('ledger.same_account', 'Debit and credit account must differ');
  }
  if (!isValidIsoDate(p.entry_date)) {
    throw badRequest('ledger.invalid_date', 'entry_date must be a real YYYY-MM-DD date');
  }
  if (!REF_TYPE.test(p.ref_type)) {
    throw badRequest(
      'ledger.invalid_ref_type',
      'A posting needs a reference type such as "payment"',
    );
  }
}

const periodLocked = (period: string) =>
  new AppError(409, 'ledger.period_locked', `Period ${period} is locked`);

/**
 * Post entries in order, in the caller's transaction. All or nothing: if any entry is invalid the
 * caller's transaction is rolled back by the thrown error, so a half-posted group cannot exist.
 */
export async function postEntries(
  tx: Db,
  entries: readonly PostingInput[],
  actor: LedgerActor,
): Promise<PostedEntry[]> {
  if (entries.length === 0) throw badRequest('ledger.nothing_to_post', 'No entries to post');
  entries.forEach(validate); // validate everything before touching the database

  const posted: PostedEntry[] = [];
  for (const p of entries) {
    try {
      const res = await tx.query(
        `INSERT INTO ledger_entries
           (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id,
            memo, created_by, reverses_seq)
         VALUES ($1::date, $2, $3, $4::bigint, $5::uuid, $6, $7::uuid, $8, $9::uuid, $10::bigint)
         RETURNING seq, hash, entry_date::text AS entry_date, debit_account, credit_account,
                   amount_paisa, member_id, ref_type, ref_id, memo, reverses_seq`,
        [
          p.entry_date,
          p.debit,
          p.credit,
          p.amount_paisa.toString(),
          p.member_id ?? null,
          p.ref_type,
          p.ref_id ?? null,
          p.memo ?? null,
          actor.userId,
          p.reverses_seq === null || p.reverses_seq === undefined
            ? null
            : p.reverses_seq.toString(),
        ],
      );
      const row = res.rows[0] as Record<string, unknown>;
      posted.push({
        seq: toBigInt(row['seq']),
        hash: row['hash'] as string,
        entry_date: row['entry_date'] as string,
        debit_account: row['debit_account'] as string,
        credit_account: row['credit_account'] as string,
        amount_paisa: toBigInt(row['amount_paisa']),
        member_id: (row['member_id'] as string | null) ?? null,
        ref_type: row['ref_type'] as string,
        ref_id: (row['ref_id'] as string | null) ?? null,
        memo: (row['memo'] as string | null) ?? null,
        reverses_seq: row['reverses_seq'] === null ? null : toBigInt(row['reverses_seq']),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const locked = /^Period (\d{4}-\d{2}) is locked/.exec(message);
      if (locked) throw periodLocked(locked[1] as string);
      if ((err as { constraint?: string }).constraint === 'ledger_one_reversal') {
        throw conflict('ledger.already_reversed', 'This entry has already been reversed');
      }
      throw err;
    }
  }
  return posted;
}

// ---- reversals ------------------------------------------------------------------------------

export interface ReverseOptions {
  /** Why the entry is being cancelled; at least 3 characters. Part of the hashed memo. */
  reason: string;
  actor: LedgerActor;
  clock: Clock;
}

interface OriginalRow {
  seq: string | bigint;
  entry_date: string;
  debit_account: string;
  credit_account: string;
  amount_paisa: string | bigint;
  member_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  reverses_seq: string | bigint | null;
}

const ORIGINAL_COLUMNS = `seq, entry_date::text AS entry_date, debit_account, credit_account,
  amount_paisa, member_id, ref_type, ref_id, reverses_seq`;

async function isLocked(tx: Db, date: string): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM periods WHERE period = to_char($1::date, 'YYYY-MM') AND locked_at IS NOT NULL`,
    [date],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Cancel one ledger entry by posting its mirror image (debit and credit swapped, same amount and
 * member). The original is never touched; both rows stay in the chain, and balances net to zero.
 *
 *  - an entry can be reversed once, and a reversal cannot itself be reversed (post a new entry);
 *  - the reversal is dated like the original while that period is open; if the original's period is
 *    locked it is dated today (Asia/Dhaka) instead; if today's period is locked too the call fails.
 */
export async function reverseEntry(
  tx: Db,
  seq: bigint,
  opts: ReverseOptions,
): Promise<PostedEntry> {
  const reason = opts.reason.trim();
  if (reason.length < MIN_REASON) {
    throw badRequest(
      'ledger.reason_required',
      `A reversal needs a reason (at least ${MIN_REASON} characters)`,
    );
  }
  // Same lock the insert trigger takes (re-entrant). Taking it first makes two simultaneous
  // reversals of one entry queue up, so the loser gets a clean "already reversed" below.
  await tx.query(`SELECT pg_advisory_xact_lock(7001)`);

  const res = await tx.query(
    `SELECT ${ORIGINAL_COLUMNS} FROM ledger_entries WHERE seq = $1::bigint`,
    [seq.toString()],
  );
  const orig = res.rows[0] as OriginalRow | undefined;
  if (!orig) throw notFound('ledger.entry_not_found', `Ledger entry #${seq} not found`);
  if (orig.reverses_seq !== null) {
    throw badRequest(
      'ledger.cannot_reverse_reversal',
      'A reversal cannot be reversed: post a new entry instead',
    );
  }
  const done = await tx.query(`SELECT seq FROM ledger_entries WHERE reverses_seq = $1::bigint`, [
    seq.toString(),
  ]);
  if ((done.rowCount ?? 0) > 0) {
    throw conflict('ledger.already_reversed', 'This entry has already been reversed');
  }

  let date = orig.entry_date;
  if (await isLocked(tx, date)) {
    date = opts.clock.todayDhaka();
    if (await isLocked(tx, date)) throw periodLocked(date.slice(0, 7));
  }

  const [entry] = await postEntries(
    tx,
    [
      {
        entry_date: date,
        debit: orig.credit_account,
        credit: orig.debit_account,
        amount_paisa: toBigInt(orig.amount_paisa),
        member_id: orig.member_id,
        ref_type: reversalRefType(orig.ref_type),
        ref_id: orig.ref_id,
        memo: `Reversal of #${seq}: ${reason}`,
        reverses_seq: seq,
      },
    ],
    opts.actor,
  );
  const posted = entry as PostedEntry;

  await audit(tx, {
    actor: opts.actor.userId,
    action: 'ledger.reverse',
    entityType: 'ledger_entry',
    entityId: seq.toString(),
    after: {
      reversal_seq: posted.seq.toString(),
      amount_paisa: posted.amount_paisa.toString(),
      entry_date: posted.entry_date,
      reason,
    },
    ip: opts.actor.ip,
    deviceId: opts.actor.deviceId ?? null,
  });
  return posted;
}

/**
 * Reverse every not-yet-reversed entry that carries `(refType, refId)`, oldest first. A payment
 * reversal uses this with `('payment', paymentId)`. Returns the reversal entries (empty when there is
 * nothing left to reverse).
 */
export async function reverseReference(
  tx: Db,
  refType: string,
  refId: string,
  opts: ReverseOptions,
): Promise<PostedEntry[]> {
  const res = await tx.query(
    `SELECT e.seq FROM ledger_entries e
     WHERE e.ref_type = $1 AND e.ref_id = $2::uuid AND e.reverses_seq IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_seq = e.seq)
     ORDER BY e.seq`,
    [refType, refId],
  );
  const reversals: PostedEntry[] = [];
  for (const row of res.rows as Array<{ seq: string | bigint }>) {
    reversals.push(await reverseEntry(tx, toBigInt(row.seq), opts));
  }
  return reversals;
}
