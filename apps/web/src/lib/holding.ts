import type { AssetRow } from './types';

/** Gold is bought many times and each purchase is its own asset row; a holding is those rows together. */
export function holdingTotals(assets: AssetRow[]) {
  const live = assets.filter((a) => a.status !== 'sold');
  const invested = live.reduce((a, x) => a + BigInt(x.cost_paisa), 0n);
  // Like NAV: an asset nobody has valued yet counts at cost.
  const value = live.reduce((a, x) => a + BigInt(x.latest_value_paisa ?? x.cost_paisa), 0n);
  const lastValued = live.reduce<string | null>((a, x) => (x.latest_value_as_of && (!a || x.latest_value_as_of > a) ? x.latest_value_as_of : a), null);
  return { invested, value, profit: value - invested, lastValued, count: live.length };
}

/**
 * Spreads one total value over the purchases in proportion to what each cost, so the sum is exact:
 * the last purchase takes the rounding remainder. Purchases that cost nothing get no valuation.
 */
export function splitByCost(total: bigint, assets: Array<{ id: string; cost_paisa: string }>): Array<{ asset_id: string; value_paisa: bigint }> {
  const priced = assets.filter((a) => BigInt(a.cost_paisa) > 0n);
  const weight = priced.reduce((a, x) => a + BigInt(x.cost_paisa), 0n);
  if (weight === 0n) return [];
  let given = 0n;
  return priced.map((a, i) => {
    const value = i === priced.length - 1 ? total - given : (total * BigInt(a.cost_paisa)) / weight;
    given += value;
    return { asset_id: a.id, value_paisa: value };
  });
}
