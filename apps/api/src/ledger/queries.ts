import type { LedgerQuery } from '@barakah/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { badRequest } from '../lib/errors';
import { paisaOut } from '../lib/money';
import { verifyLedgerChainFromDb, type Queryable } from '../lib/ledger-chain';
import type { Db } from '../lib/tx';

export interface LedgerPage {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

const SELECT = `
  SELECT le.seq::text AS seq, le.entry_date::text AS entry_date, le.debit_account, le.credit_account,
         le.amount_paisa, le.member_id, m.code AS member_code, le.ref_type, le.ref_id, le.memo,
         le.hash, le.reverses_seq::text AS reverses_seq, rv.seq::text AS reversed_by_seq,
         pc.code AS posted_by_code,
         (SELECT count(*)::int FROM objections o WHERE o.ledger_seq = le.seq AND o.status = 'open')
           AS open_objections
  FROM ledger_entries le
  LEFT JOIN members m ON m.id = le.member_id
  LEFT JOIN ledger_entries rv ON rv.reverses_seq = le.seq
  LEFT JOIN users pu ON pu.id = le.created_by
  LEFT JOIN members pc ON pc.id = pu.member_id
  WHERE ($1::date IS NULL OR le.entry_date >= $1::date)
    AND ($2::date IS NULL OR le.entry_date <= $2::date)
    AND ($3::text IS NULL OR le.debit_account = $3 OR le.credit_account = $3)
    AND ($4::uuid IS NULL OR le.member_id = $4::uuid)
    AND ($5::text IS NULL OR le.ref_type = $5)
    AND ($6::uuid IS NULL OR le.ref_id = $6::uuid)`;

/**
 * The ledger as every member sees it (spec 7): rows with their hash, who posted them, the link to
 * their reversal (either way) and a badge counting open objections. Keyset paging on `seq`
 * (newest first unless `order=asc`), so a page never repeats or skips a row even while new entries
 * arrive.
 */
export async function listLedger(db: Db, q: LedgerQuery): Promise<LedgerPage> {
  const cursor = decodeCursor(q.cursor, 1);
  if (cursor && !/^\d{1,18}$/.test(cursor[0] as string)) {
    throw badRequest('request.invalid_cursor', 'The cursor is not valid');
  }
  const desc = q.order === 'desc';
  const res = await db.query(
    `${SELECT}
       AND ($7::bigint IS NULL OR le.seq ${desc ? '<' : '>'} $7::bigint)
     ORDER BY le.seq ${desc ? 'DESC' : 'ASC'}
     LIMIT $8`,
    [
      q.from ?? null,
      q.to ?? null,
      q.account ?? null,
      q.member_id ?? null,
      q.ref_type ?? null,
      q.ref_id ?? null,
      cursor?.[0] ?? null,
      q.limit + 1,
    ],
  );
  const rows = res.rows as Array<Record<string, unknown> & { seq: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...r, amount_paisa: paisaOut(r['amount_paisa']) })),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.seq]) : null,
  };
}

const MAX_ISSUES_SHOWN = 20;

export interface LedgerVerification {
  ok: boolean;
  count: number;
  last_seq: string | null;
  last_hash: string;
  issues_total: number;
  /** The first few problems (row and kind only), enough to point the auditor at the damage. */
  issues: Array<{ seq: string; kind: 'prev_hash' | 'hash' }>;
}

/**
 * Recompute the whole hash chain in TypeScript and compare it with what the database stored
 * (spec 5.6). Detects an edited row (`hash`), a deleted or reordered row (`prev_hash`) and a
 * truncated tail only if the caller remembers an earlier `last_hash`.
 */
export async function verifyLedger(db: Queryable): Promise<LedgerVerification> {
  const result = await verifyLedgerChainFromDb(db);
  return {
    ok: result.ok,
    count: result.count,
    last_seq: result.lastSeq,
    last_hash: result.lastHash,
    issues_total: result.issues.length,
    issues: result.issues.slice(0, MAX_ISSUES_SHOWN).map((i) => ({ seq: i.seq, kind: i.kind })),
  };
}
