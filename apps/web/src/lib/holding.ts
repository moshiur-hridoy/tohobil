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

export { splitByCost } from '@barakah/shared';
