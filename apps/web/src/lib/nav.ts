import { NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS, divRound } from '@barakah/shared';
import type { AccountBalance, NavResponse } from './types';

/**
 * Net assets for the home and dashboard screens until `GET /nav` exists (Phase 4): cash accounts plus
 * non-cash assets at cost, minus every balance that is owed to someone else (charity, escrow, ...).
 * The spec's NAV replaces cost with valuations; the figure is labelled "interim" on screen.
 */
export function interimNetAssets(accounts: AccountBalance[]): bigint {
  const natural = (code: string): bigint => {
    const row = accounts.find((a) => a.code === code);
    return row ? BigInt(row.natural_balance_paisa) : 0n;
  };
  let total = natural('INVESTMENTS_AT_COST');
  for (const code of NAV_CASH_ACCOUNTS) total += natural(code);
  for (const code of NAV_DEDUCTION_ACCOUNTS) total -= natural(code);
  return total;
}

export const charityBalance = (accounts: AccountBalance[]): bigint =>
  BigInt(accounts.find((a) => a.code === 'CHARITY_PAYABLE')?.natural_balance_paisa ?? '0');

/**
 * Where the fund's money is, from `GET /nav`: cash in every cash account, held assets at their latest
 * value, and what is owed to others. `cash + invested - owed` is exactly the server's net assets.
 */
export function fundSplit(nav: NavResponse): { cash: bigint; invested: bigint; owed: bigint; net: bigint } {
  const sum = (rows: Array<{ balance_paisa: string } | { valuation_paisa: string }>) =>
    rows.reduce((s, r) => s + BigInt('balance_paisa' in r ? r.balance_paisa : r.valuation_paisa), 0n);
  return { cash: sum(nav.cash), invested: sum(nav.assets), owed: sum(nav.deductions), net: BigInt(nav.net_assets_paisa) };
}

/**
 * A member's part of the fund today: `divRound(shares * net_assets, shares_outstanding)`, the
 * settlement "gross" of Doc.md 5.10 before arrears are taken off. 0 when no shares are outstanding.
 */
export function shareValue(nav: NavResponse, shares: number): bigint {
  const outstanding = BigInt(nav.shares_outstanding);
  return outstanding > 0n ? divRound(BigInt(shares) * BigInt(nav.net_assets_paisa), outstanding) : 0n;
}
