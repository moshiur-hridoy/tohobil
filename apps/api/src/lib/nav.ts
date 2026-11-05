import { divRound, NAV_DEDUCTION_ACCOUNTS, navDeduction } from '@barakah/shared';
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

/**
 * Members' money paid ahead and not yet spent on a due (`payments.unallocated_paisa`): theirs until
 * the month it pays comes, so NAV counts it as owed to them, like escrow (docs/ASSUMPTIONS.md 120).
 * The money stays in the fund's accounts and can be spent or invested. With `memberId`, that member's
 * alone. Members whose settlement was executed are left out: their capital, this credit included, was
 * moved to SETTLEMENT_PAYABLE (older settlements did not clear the credit).
 */
export async function unspentAdvance(db: Db, memberId?: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(p.unallocated_paisa), 0)::text AS total
     FROM payments p
     WHERE p.status = 'confirmed' AND p.unallocated_paisa > 0
       AND ($1::uuid IS NULL OR p.member_id = $1::uuid)
       AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.member_id = p.member_id AND s.status IN ('paying', 'completed'))`,
    [memberId ?? null],
  );
  return toBigInt((res.rows[0] as { total: string }).total);
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
  /** Deductions, the members' unspent advance included. */
  deductions_paisa: bigint;
  /** Members' unspent advance (part of `deductions_paisa`). */
  advance_paisa: bigint;
  asset_breakdown: NavAssetBreakdown[];
}

/**
 * Compute net asset value (spec 5.7 as amended by 18.4 and 19.2).
 *
 *   cash          = natural balance of CASH, BANK, BKASH, NAGAD
 *   assets        = latest approved valuation of every held asset (cost if no valuation),
 *                   or cost paid so far for assets still being acquired.
 *   deductions    = natural balance of the NAV deduction accounts (a levy deficit counts as 0,
 *                   navDeduction), plus members' unspent advance
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

  const deductionRows = (await db.query(
    `SELECT code, natural_balance_paisa::text AS total
     FROM v_account_balances
     WHERE code = ANY($1::text[])`,
    [NAV_DEDUCTION_ACCOUNTS],
  )).rows as Array<{ code: string; total: string }>;
  const advancePaisa = await unspentAdvance(db);
  const deductionsPaisa =
    deductionRows.reduce((sum, r) => sum + navDeduction(r.code, toBigInt(r.total)), 0n) + advancePaisa;

  const assetRows = (await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (asset_id)
         asset_id, value_paisa, as_of
       FROM asset_valuations
       ORDER BY asset_id, as_of DESC, created_at DESC
     )
     SELECT a.id, a.name, a.status,
            a.cost_paisa::text AS cost_paisa,
            a.acquired_on::text AS acquired_on,
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
    acquired_on: string | null;
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

    // A held asset never valued counts its purchase as its valuation (docs/ASSUMPTIONS.md 119):
    // just bought is not stale. With no purchase date either, it is stale.
    if (row.status === 'held') {
      const valuedOn = row.as_of ?? row.acquired_on;
      if (!valuedOn) {
        stale = true;
      } else {
        const age = Math.floor(
          (new Date(date).getTime() - new Date(valuedOn).getTime()) /
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
    advance_paisa: advancePaisa,
    asset_breakdown: assetBreakdown,
  };
}

/**
 * True if any held asset's valuation is older than the limit (computeNav works it out). An asset never
 * valued is not stale by itself: its purchase counts as its valuation (docs/ASSUMPTIONS.md 119).
 */
export function hasStaleValuations(nav: NavResult, _maxAgeDays: number, _today: string): boolean {
  return nav.stale_valuations;
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
