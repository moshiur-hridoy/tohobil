import type pg from 'pg';
import { type Clock, NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS } from '@barakah/shared';
import { ruleInt } from '../lib/rules';

export interface NavDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface NavBreakdown {
  net_assets_paisa: bigint;
  shares_outstanding: bigint;
  nav_per_share_paisa: bigint;
  cash: { account: string; balance_paisa: bigint }[];
  assets: { id: string; name: string; status: string; valuation_paisa: bigint; value_as_of: string | null }[];
  deductions: { account: string; balance_paisa: bigint }[];
  stale_valuations: { id: string; name: string; latest_as_of: string | null }[];
}

function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  const sign = (a < 0n) !== (b < 0n) ? -1n : 1n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const half = absB / 2n;
  return sign * ((absA + half) / absB);
}

export async function computeNav(deps: NavDeps): Promise<NavBreakdown> {
  const today = deps.clock.todayDhaka();
  const asOf = today;

  const [balances, latestValues, shares, heldAssets] = await Promise.all([
    deps.pool.query(
      `SELECT code, balance_paisa, natural_balance_paisa
       FROM v_account_balances
       WHERE code = ANY($1) OR code = ANY($2)`,
      [NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS],
    ),
    deps.pool.query(
      `SELECT DISTINCT ON (asset_id) asset_id, value_paisa, as_of
       FROM asset_valuations
       ORDER BY asset_id, as_of DESC, created_at DESC`,
    ),
    deps.pool.query(
      `SELECT COALESCE(SUM(sh.shares),0) AS total
       FROM share_holdings sh
       JOIN members m ON m.id = sh.member_id
       WHERE sh.effective_from <= $1::date
         AND (sh.effective_to IS NULL OR sh.effective_to >= $1::date)
         AND m.status IN ('active','warning','suspended','deceased')`,
      [asOf],
    ),
    deps.pool.query(
      `SELECT id, name, status, cost_paisa FROM assets WHERE status IN ('held','acquiring')`,
    ),
  ]);

  const balanceMap = new Map<string, bigint>();
  for (const row of balances.rows as Array<{ code: string; balance_paisa: string | bigint; natural_balance_paisa: string | bigint }>) {
    if (NAV_CASH_ACCOUNTS.includes(row.code as typeof NAV_CASH_ACCOUNTS[number])) {
      balanceMap.set(row.code, BigInt(row.balance_paisa));
    } else if (NAV_DEDUCTION_ACCOUNTS.includes(row.code as typeof NAV_DEDUCTION_ACCOUNTS[number])) {
      balanceMap.set(row.code, BigInt(row.natural_balance_paisa));
    }
  }

  const valuationMap = new Map<string, { value_paisa: bigint; as_of: string }>();
  for (const row of latestValues.rows as Array<{ asset_id: string; value_paisa: string | bigint; as_of: string }>) {
    valuationMap.set(row.asset_id, { value_paisa: BigInt(row.value_paisa), as_of: row.as_of });
  }

  const cash = NAV_CASH_ACCOUNTS.map((account) => ({
    account,
    balance_paisa: balanceMap.get(account) ?? 0n,
  }));
  const cashTotal = cash.reduce((sum, c) => sum + c.balance_paisa, 0n);

  const assets: NavBreakdown['assets'] = [];
  let assetTotal = 0n;
  for (const row of heldAssets.rows as Array<{ id: string; name: string; status: string; cost_paisa: string | bigint }>) {
    const val = valuationMap.get(row.id);
    const value_paisa = val?.value_paisa ?? BigInt(row.cost_paisa);
    assetTotal += value_paisa;
    assets.push({
      id: row.id,
      name: row.name,
      status: row.status,
      valuation_paisa: value_paisa,
      value_as_of: val?.as_of ?? null,
    });
  }

  const deductions = NAV_DEDUCTION_ACCOUNTS.map((account) => ({
    account,
    balance_paisa: balanceMap.get(account) ?? 0n,
  }));
  const deductionsTotal = deductions.reduce((sum, d) => sum + d.balance_paisa, 0n);

  const net_assets = cashTotal + assetTotal - deductionsTotal;
  const shares_outstanding = BigInt((shares.rows[0] as { total: string | bigint }).total);
  const nav_per_share_paisa = shares_outstanding > 0n ? divRound(net_assets, shares_outstanding) : 0n;

  const maxAgeDays = await ruleInt(deps.pool, 'valuation_max_age_days', today).catch(() => 365);
  const stale: NavBreakdown['stale_valuations'] = [];
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  for (const a of assets) {
    if (a.status !== 'held') continue;
    if (!a.value_as_of || new Date(a.value_as_of) < cutoff) {
      stale.push({ id: a.id, name: a.name, latest_as_of: a.value_as_of });
    }
  }

  return {
    net_assets_paisa: net_assets,
    shares_outstanding,
    nav_per_share_paisa,
    cash,
    assets,
    deductions,
    stale_valuations: stale,
  };
}
