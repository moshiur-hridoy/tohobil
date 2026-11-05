import { NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS, divRound, navDeduction } from '@barakah/shared';
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
  for (const code of NAV_DEDUCTION_ACCOUNTS) total -= navDeduction(code, natural(code));
  return total;
}

export const charityBalance = (accounts: AccountBalance[]): bigint =>
  BigInt(accounts.find((a) => a.code === 'CHARITY_PAYABLE')?.natural_balance_paisa ?? '0');

/**
 * The home card's split of `GET /nav` (owner request, docs/ASSUMPTIONS.md 121). The sadaqah fund, the
 * levy money held and anything else owed to others come off the cash, so `ownCash` is the fund's own;
 * `total = ownCash + invested`. The members' advance stays in the total (it is spent or invested like
 * any cash), so `total` is the server's net assets plus `advance`; the share value still leaves it out.
 */
export function fundSplit(nav: NavResponse): { cash: bigint; ownCash: bigint; invested: bigint; charity: bigint; levy: bigint; otherOwed: bigint; advance: bigint; total: bigint } {
  const sum = (rows: Array<{ balance_paisa: string } | { valuation_paisa: string }>) =>
    rows.reduce((s, r) => s + BigInt('balance_paisa' in r ? r.balance_paisa : r.valuation_paisa), 0n);
  const of = (account: string) => sum(nav.deductions.filter((d) => d.account === account));
  const cash = sum(nav.cash);
  const invested = sum(nav.assets);
  const charity = of('CHARITY_PAYABLE');
  const levy = of('LEVY_CLEARING');
  const advance = memberAdvance(nav);
  const otherOwed = sum(nav.deductions) - charity - levy - advance;
  const ownCash = cash - charity - levy - otherOwed;
  return { cash, ownCash, invested, charity, levy, otherOwed, advance, total: ownCash + invested };
}

/** The members' unspent advance in `GET /nav`: in the fund's accounts, but theirs until the month comes. */
export function memberAdvance(nav: NavResponse): bigint {
  return BigInt(nav.deductions.find((d) => d.account === 'MEMBER_ADVANCE')?.balance_paisa ?? '0');
}

/**
 * A member's part of the fund today: `divRound(shares * net_assets, shares_outstanding)`, the
 * settlement "gross" of Doc.md 5.10 before arrears are taken off. 0 when no shares are outstanding.
 */
export function shareValue(nav: NavResponse, shares: number): bigint {
  const outstanding = BigInt(nav.shares_outstanding);
  return outstanding > 0n ? divRound(BigInt(shares) * BigInt(nav.net_assets_paisa), outstanding) : 0n;
}
