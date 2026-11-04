import { describe, expect, it } from 'vitest';
import { fundSplit, shareValue } from './nav';
import type { NavResponse } from './types';

const nav: NavResponse = {
  net_assets_paisa: '50000000',
  shares_outstanding: '30',
  nav_per_share_paisa: '1666667',
  cash: [
    { account: 'CASH_BANK', balance_paisa: '12000000' },
    { account: 'CASH_BKASH', balance_paisa: '1000000' },
  ],
  assets: [
    { id: 'a', name: 'Gold shop', status: 'held', valuation_paisa: '30000000', value_as_of: '2026-10-01' },
    { id: 'b', name: 'Land', status: 'held', valuation_paisa: '10000000', value_as_of: null },
  ],
  deductions: [
    { account: 'CHARITY_PAYABLE', balance_paisa: '2500000' },
    { account: 'MEMBER_ESCROW', balance_paisa: '500000' },
  ],
  stale_valuations: [],
};

describe('fundSplit', () => {
  it('adds up to the server net assets', () => {
    const s = fundSplit(nav);
    expect(s).toEqual({ cash: 13000000n, invested: 40000000n, owed: 3000000n, net: 50000000n });
    expect(s.cash + s.invested - s.owed).toBe(s.net);
  });
});

describe('shareValue', () => {
  it('multiplies before dividing, like the settlement gross', () => {
    // 4 of 30 shares of ৳5,00,000 = ৳66,666.666… → rounds to 6666667 paisa (4 × nav_per_share would give 6666668).
    expect(shareValue(nav, 4)).toBe(6666667n);
  });

  it('is zero when nobody holds shares', () => {
    expect(shareValue({ ...nav, shares_outstanding: '0' }, 4)).toBe(0n);
  });
});
