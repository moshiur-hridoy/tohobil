import { divRound, NAV_DEDUCTION_ACCOUNTS } from '@barakah/shared';
import { ruleInt } from './rules';
import { toBigInt } from './money';
import type { Db } from './tx';

export interface NavAssetBreakdown {
  asset_id: string;
  name: string;
  status: string;
  value_paisa: bigint;
  basis: 'valuation' | 'cost';
}

export interface NavResult {
  /** Net assets in paisa (spec 5.7). */
  net_assets: bigint;
  /** Alias used by the entry module. */
  net_assets_paisa: bigint;
  shares_outstanding: number;
  nav_per_share: bigint;
  /** True if any held asset valuation is stale or missing. */
  stale_valuations: boolean;
  cash_paisa: bigint;
  assets_paisa: bigint;
  deductions_paisa: bigint;
  asset_breakdown: NavAssetBreakdown[];
}

/**
 * Compute net asset value (spec 5.7 as amended by 18.4 and 19.2).
 *
 *   cash          = natural balance of CASH, BANK, BKASH, NAGAD
 *   assets        = latest approved valuation of every held asset (cost if no valuation),
 *                   or cost paid so far for assets still being acquired.
 *   deductions    = natural balance of the NAV deduction accounts
 *   net_assets    = cash + assets - deductions
 *   shares        = shares today for active, warning, suspended, deceased members
 *   nav_per_share = divRound(net_assets, shares) (0 if no shares)
 */
export async function computeNav(db: Db, date: string): Promise<NavResult> {
  const maxAge = await ruleInt(db, 'valuation_max_age_days', date);

  const cashRows = await db.query(
    `SELECT COALESCE(SUM(natural_balance_paisa), 0)::text AS total
     FROM v_account_balances
     WHERE is_cash = true`,
  );
  const cashPaisa = toBigInt((cashRows.rows[0] as { total: string }).total);

  const deductionRows = await db.query(
    `SELECT COALESCE(SUM(natural_balance_paisa), 0)::text AS total
     FROM v_account_balances
     WHERE code = ANY($1::text[])`,
    [NAV_DEDUCTION_ACCOUNTS],
  );
  const deductionsPaisa = toBigInt((deductionRows.rows[0] as { total: string }).total);

  const assetRows = (await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (asset_id)
         asset_id, value_paisa, as_of
       FROM asset_valuations
       ORDER BY asset_id, as_of DESC, created_at DESC
     )
     SELECT a.id, a.name, a.status,
            a.cost_paisa::text AS cost_paisa,
            COALESCE(lv.value_paisa, a.cost_paisa)::text AS value_paisa,
            lv.as_of::text AS as_of
     FROM assets a
     LEFT JOIN latest lv ON lv.asset_id = a.id
     WHERE a.status IN ('held', 'acquiring')`,
  )).rows as Array<{
    id: string;
    name: string;
    status: string;
    cost_paisa: string;
    value_paisa: string;
    as_of: string | null;
  }>;

  let assetsPaisa = 0n;
  let stale = false;
  const assetBreakdown: NavAssetBreakdown[] = [];

  for (const row of assetRows) {
    const value =
      row.status === 'acquiring'
        ? toBigInt(row.cost_paisa)
        : toBigInt(row.value_paisa);
    assetsPaisa += value;

    if (row.status === 'held') {
      if (!row.as_of) {
        stale = true;
      } else {
        const age = Math.floor(
          (new Date(date).getTime() - new Date(row.as_of).getTime()) /
            (1000 * 60 * 60 * 24),
        );
        if (age > maxAge) stale = true;
      }
    }

    assetBreakdown.push({
      asset_id: row.id,
      name: row.name,
      status: row.status,
      value_paisa: value,
      basis: row.status === 'acquiring' || !row.as_of ? 'cost' : 'valuation',
    });
  }

  const sharesRows = await db.query(
    `SELECT COALESCE(SUM(shares_on(m.id, $1::date)), 0)::int AS total
     FROM members m
     WHERE m.status IN ('active', 'warning', 'suspended', 'deceased')`,
    [date],
  );
  const sharesOutstanding = Number((sharesRows.rows[0] as { total: number }).total);

  const netAssets = cashPaisa + assetsPaisa - deductionsPaisa;
  const navPerShare = sharesOutstanding > 0 ? divRound(netAssets, BigInt(sharesOutstanding)) : 0n;

  return {
    net_assets: netAssets,
    net_assets_paisa: netAssets,
    shares_outstanding: sharesOutstanding,
    nav_per_share: navPerShare,
    stale_valuations: stale,
    cash_paisa: cashPaisa,
    assets_paisa: assetsPaisa,
    deductions_paisa: deductionsPaisa,
    asset_breakdown: assetBreakdown,
  };
}

/** True if any held asset valuation is older than maxAgeDays or is missing. */
export function hasStaleValuations(nav: NavResult, _maxAgeDays: number, _today: string): boolean {
  return nav.asset_breakdown.some((a) => {
    if (a.status !== 'held') return false;
    if (a.basis === 'cost') return true;
    // The computeNav result already flags staleness; reuse it.
    return nav.stale_valuations;
  });
}

/** Entry price for n shares = divRound(net_assets * n, shares_outstanding) (spec 5.9). */
export function entryPriceForShares(nav: NavResult, shares: number): bigint {
  if (nav.shares_outstanding === 0) return 0n;
  return divRound(nav.net_assets_paisa * BigInt(shares), BigInt(nav.shares_outstanding));
}

/** Convenience: the natural balance of one account. */
export async function accountBalance(db: Db, account: string): Promise<bigint> {
  const res = await db.query(
    `SELECT natural_balance_paisa::text AS total FROM v_account_balances WHERE code = $1`,
    [account],
  );
  const row = res.rows[0] as { total: string | null } | undefined;
  return row?.total ? toBigInt(row.total) : 0n;
}

/** The balance of a member-specific liability/equity account. */
export async function memberAccountBalance(db: Db, account: string, memberId: string): Promise<bigint> {
  const credit = await db.query(
    `SELECT COALESCE(SUM(amount_paisa), 0)::text AS total FROM ledger_entries
     WHERE credit_account = $1 AND member_id = $2`,
    [account, memberId],
  );
  const debit = await db.query(
    `SELECT COALESCE(SUM(amount_paisa), 0)::text AS total FROM ledger_entries
     WHERE debit_account = $1 AND member_id = $2`,
    [account, memberId],
  );
  return (
    toBigInt((credit.rows[0] as { total: string }).total) -
    toBigInt((debit.rows[0] as { total: string }).total)
  );
}

/** Convenience: a member's escrow balance (CR - DR of MEMBER_ESCROW). */
export async function memberEscrowBalance(db: Db, memberId: string): Promise<bigint> {
  return memberAccountBalance(db, 'MEMBER_ESCROW', memberId);
}

/** Total outstanding principal for a member from v_due_status. */
export async function memberOutstandingPrincipal(db: Db, memberId: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(outstanding_paisa), 0)::text AS total
     FROM v_due_status
     WHERE member_id = $1 AND outstanding_paisa > 0`,
    [memberId],
  );
  return toBigInt((res.rows[0] as { total: string }).total);
}

/** Total outstanding (unwaived) fines for a member from v_fine_status. */
export async function memberOutstandingFines(db: Db, memberId: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(outstanding_paisa), 0)::text AS total
     FROM v_fine_status
     WHERE member_id = $1 AND outstanding_paisa > 0`,
    [memberId],
  );
  return toBigInt((res.rows[0] as { total: string }).total);
}
