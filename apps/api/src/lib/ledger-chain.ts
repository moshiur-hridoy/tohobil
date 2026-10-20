import { createHash } from 'node:crypto';

/**
 * Ledger hash chain (spec 5.6).
 *
 * The database trigger `ledger_hash_chain` computes
 *   hash = sha256(prev_hash || '|' || canonical)
 * and this module recomputes it. The two must agree byte for byte, so every field is read from the
 * database as the exact text the trigger used (no driver type conversion: `date` and `timestamptz`
 * would otherwise be turned into JS Dates, and microseconds would be lost).
 */

export const ZERO_HASH = '0'.repeat(64);

/** Reads each ledger row with its canonical fields rendered exactly as the trigger renders them. */
export const LEDGER_CHAIN_SQL = `
  SELECT
    seq::text AS seq,
    to_char(entry_date, 'YYYY-MM-DD') AS entry_date,
    debit_account,
    credit_account,
    amount_paisa::text AS amount_paisa,
    member_id::text AS member_id,
    ref_type,
    ref_id::text AS ref_id,
    memo,
    created_by::text AS created_by,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    prev_hash,
    hash
  FROM ledger_entries
  -- Qualified on purpose: a bare "ORDER BY seq" would sort by the text alias above ('10' < '2').
  ORDER BY ledger_entries.seq ASC`;

export interface LedgerChainRow {
  seq: string;
  entry_date: string;
  debit_account: string;
  credit_account: string;
  amount_paisa: string;
  member_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  created_by: string | null;
  /** Already formatted as YYYY-MM-DD"T"HH24:MI:SS.US"Z" by LEDGER_CHAIN_SQL. */
  created_at: string;
  prev_hash: string;
  hash: string;
}

export function ledgerCanonical(row: LedgerChainRow): string {
  return [
    row.seq,
    row.entry_date,
    row.debit_account,
    row.credit_account,
    row.amount_paisa,
    row.member_id ?? '',
    row.ref_type ?? '',
    row.ref_id ?? '',
    row.memo ?? '',
    row.created_by ?? '',
    row.created_at,
  ].join('|');
}

export function computeLedgerHash(prevHash: string, row: LedgerChainRow): string {
  return createHash('sha256')
    .update(prevHash + '|' + ledgerCanonical(row))
    .digest('hex');
}

export interface ChainIssue {
  seq: string;
  kind: 'prev_hash' | 'hash';
  expected: string;
  actual: string;
}

export interface ChainResult {
  ok: boolean;
  count: number;
  lastSeq: string | null;
  lastHash: string;
  issues: ChainIssue[];
}

/**
 * Walks rows in seq order. Two independent checks per row:
 *  - `prev_hash` must equal the previous row's stored hash (detects deleted or reordered rows);
 *  - `hash` must equal sha256 of the row's own stored prev_hash and content (detects edited rows).
 */
export function verifyLedgerChain(rows: readonly LedgerChainRow[]): ChainResult {
  const issues: ChainIssue[] = [];
  let previous = ZERO_HASH;

  for (const row of rows) {
    if (row.prev_hash !== previous) {
      issues.push({ seq: row.seq, kind: 'prev_hash', expected: previous, actual: row.prev_hash });
    }
    const expectedHash = computeLedgerHash(row.prev_hash, row);
    if (row.hash !== expectedHash) {
      issues.push({ seq: row.seq, kind: 'hash', expected: expectedHash, actual: row.hash });
    }
    previous = row.hash;
  }

  const last = rows[rows.length - 1];
  return {
    ok: issues.length === 0,
    count: rows.length,
    lastSeq: last ? last.seq : null,
    lastHash: previous,
    issues,
  };
}

export interface Queryable {
  query(sql: string): Promise<{ rows: LedgerChainRow[] }>;
}

export async function verifyLedgerChainFromDb(db: Queryable): Promise<ChainResult> {
  const { rows } = await db.query(LEDGER_CHAIN_SQL);
  return verifyLedgerChain(rows);
}
