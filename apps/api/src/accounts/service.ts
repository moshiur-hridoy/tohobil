import { ACCOUNT_CODES } from '@barakah/shared';
import { paisaOut } from '../lib/money';
import type { Db } from '../lib/tx';

/** Accounts that exist as rows for legacy reasons but accept no new postings (spec 18.2). */
const RETIRED_ACCOUNTS: ReadonlySet<string> = new Set(['FINE_INCOME']);

/**
 * The chart of accounts with each account's balance, from `v_account_balances` (spec 5.6).
 *
 *  - `balance_paisa` is raw debits minus credits (can be negative).
 *  - `natural_balance_paisa` is positive in the account's normal direction (debit for asset and
 *    expense, credit for liability, equity and income). Use it to read liabilities such as
 *    `SETTLEMENT_PAYABLE`; NAV and reports must too (assumption 26).
 *
 * Accounts come in the order of the chart in `ACCOUNT_CODES` (assets first), not alphabetically.
 */
export async function listAccountBalances(db: Db): Promise<{ items: unknown[] }> {
  const res = await db.query(
    `SELECT code, name, kind, is_cash, balance_paisa, natural_balance_paisa FROM v_account_balances`,
  );
  const order = new Map<string, number>(ACCOUNT_CODES.map((code, i) => [code, i]));
  const rows = (res.rows as Array<Record<string, unknown> & { code: string }>).sort(
    (a, b) =>
      (order.get(a.code) ?? 1e6) - (order.get(b.code) ?? 1e6) || a.code.localeCompare(b.code),
  );
  return {
    items: rows.map((r) => ({
      code: r.code,
      name: r['name'],
      kind: r['kind'],
      is_cash: r['is_cash'],
      retired: RETIRED_ACCOUNTS.has(r.code),
      balance_paisa: paisaOut(r['balance_paisa']),
      natural_balance_paisa: paisaOut(r['natural_balance_paisa']),
    })),
  };
}
