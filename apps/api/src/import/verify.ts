import type pg from 'pg';
import { verifyLedgerChainFromDb } from '../lib/ledger-chain';
import { toBigInt } from '../lib/money';
import type { Dataset } from './schemas';

/**
 * `pnpm import:verify` (Doc.md 13): proves the loaded numbers match the sheet. Read-only.
 *
 *  1. per member: principal paid, fines paid, principal outstanding and fines outstanding equal
 *     `expected_totals.csv`;
 *  2. cash by account equals `opening_balances.csv` (the loader posted OPENING_ADJUSTMENT for any gap);
 *  3. the ledger hash chain verifies;
 *  4. no due or fine has a negative outstanding;
 *  5. no TrxID is used twice by a live payment.
 */

export interface VerifyReport {
  ok: boolean;
  failures: string[];
  members_checked: number;
  /** Adjustments the opening-balance step posted (for the auditor's review list). */
  opening_adjustments: Array<{ account: string; net_paisa: string }>;
  ledger: { count: number; last_hash: string };
}

type Expected = Pick<Dataset, 'expected_totals' | 'opening_balances'>;

export async function verifyImport(db: pg.Pool | pg.Client, expected: Expected): Promise<VerifyReport> {
  const failures: string[] = [];

  // 1. per member totals
  const rows = await db.query(
    `SELECT m.code,
            COALESCE((SELECT SUM(pa.amount_paisa) FROM payment_allocations pa
                      JOIN payments p ON p.id = pa.payment_id
                      WHERE p.member_id = m.id AND pa.due_id IS NOT NULL), 0) AS principal_paid,
            COALESCE((SELECT SUM(pa.amount_paisa) FROM payment_allocations pa
                      JOIN payments p ON p.id = pa.payment_id
                      WHERE p.member_id = m.id AND pa.fine_id IS NOT NULL), 0) AS fines_paid,
            COALESCE((SELECT SUM(GREATEST(outstanding_paisa, 0)) FROM v_due_status WHERE member_id = m.id), 0) AS principal_outstanding,
            COALESCE((SELECT SUM(GREATEST(outstanding_paisa, 0)) FROM v_fine_status WHERE member_id = m.id), 0) AS fines_outstanding
     FROM members m`,
  );
  const actual = new Map(
    (rows.rows as Array<Record<string, unknown>>).map((r) => [
      r['code'] as string,
      {
        principal_paid_paisa: toBigInt(r['principal_paid']),
        fines_paid_paisa: toBigInt(r['fines_paid']),
        principal_outstanding_paisa: toBigInt(r['principal_outstanding']),
        fines_outstanding_paisa: toBigInt(r['fines_outstanding']),
      },
    ]),
  );
  for (const e of expected.expected_totals) {
    const a = actual.get(e.member_key);
    if (!a) {
      failures.push(`${e.member_key}: member is not in the database`);
      continue;
    }
    for (const field of ['principal_paid_paisa', 'fines_paid_paisa', 'principal_outstanding_paisa', 'fines_outstanding_paisa'] as const) {
      if (a[field] !== e[field]) {
        failures.push(`${e.member_key} ${field}: sheet ${e[field]}, system ${a[field]} (difference ${a[field] - e[field]})`);
      }
    }
  }

  // 2. cash by account, and the adjustments that made it match
  const bal = await db.query(
    `SELECT a.code,
            COALESCE(SUM(CASE WHEN e.debit_account = a.code THEN e.amount_paisa ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN e.credit_account = a.code THEN e.amount_paisa ELSE 0 END), 0) AS net
     FROM (VALUES ('CASH'),('BANK'),('BKASH'),('NAGAD')) AS a(code)
     LEFT JOIN ledger_entries e ON e.debit_account = a.code OR e.credit_account = a.code
     GROUP BY a.code`,
  );
  const cash = new Map((bal.rows as Array<{ code: string; net: unknown }>).map((r) => [r.code, toBigInt(r.net)]));
  for (const o of expected.opening_balances) {
    const system = cash.get(o.account) ?? 0n;
    if (system !== o.actual_balance_paisa) {
      failures.push(`${o.account} balance: sheet ${o.actual_balance_paisa}, system ${system} (difference ${system - o.actual_balance_paisa})`);
    }
  }
  const adj = await db.query(
    `SELECT CASE WHEN debit_account = 'OPENING_ADJUSTMENT' THEN credit_account ELSE debit_account END AS account,
            SUM(CASE WHEN debit_account = 'OPENING_ADJUSTMENT' THEN -amount_paisa ELSE amount_paisa END) AS net
     FROM ledger_entries WHERE debit_account = 'OPENING_ADJUSTMENT' OR credit_account = 'OPENING_ADJUSTMENT'
     GROUP BY 1 ORDER BY 1`,
  );

  // 3. hash chain
  const chain = await verifyLedgerChainFromDb(db as { query(sql: string): Promise<{ rows: never[] }> } & pg.Pool);
  if (!chain.ok) failures.push(`Ledger hash chain is broken: ${chain.issues.length} issue(s), first at seq ${chain.issues[0]?.seq}`);

  // 4. negative outstanding
  const neg = await db.query(
    `SELECT 'due' AS what, due_id::text AS id FROM v_due_status WHERE outstanding_paisa < 0
     UNION ALL SELECT 'fine', fine_id::text FROM v_fine_status WHERE outstanding_paisa < 0`,
  );
  for (const r of neg.rows as Array<{ what: string; id: string }>) failures.push(`Negative outstanding on ${r.what} ${r.id}`);

  // 5. duplicate TrxID
  const dup = await db.query(
    `SELECT upper(trim(trx_id)) AS trx, count(*)::int AS n FROM payments
     WHERE trx_id IS NOT NULL AND status IN ('pending','confirmed') GROUP BY 1 HAVING count(*) > 1`,
  );
  for (const r of dup.rows as Array<{ trx: string; n: number }>) failures.push(`TrxID ${r.trx} is used by ${r.n} payments`);

  return {
    ok: failures.length === 0,
    failures,
    members_checked: expected.expected_totals.length,
    opening_adjustments: (adj.rows as Array<{ account: string; net: unknown }>).map((r) => ({
      account: r.account,
      net_paisa: toBigInt(r.net).toString(),
    })),
    ledger: { count: chain.count, last_hash: chain.lastHash },
  };
}
