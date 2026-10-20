import { NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS } from '@barakah/shared';
import type { AccountBalance } from './types';

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
