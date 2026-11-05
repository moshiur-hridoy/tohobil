import { describe, expect, it } from 'vitest';
import { fundSplit, shareValue } from './nav';
import type { NavResponse } from './types';

const nav: NavResponse = {
  net_assets_paisa: '50000000',
  shares_outstanding: '30',
  nav_per_share_paisa: '1666667',
  cash: [
    { account: 'CASH_BANK', balance_paisa: '12000000' },
    { account: 'CASH_BKASH', balance_paisa: '1200000' },
  ],
  assets: [
    { id: 'a', name: 'Gold shop', status: 'held', valuation_paisa: '30000000', value_as_of: '2026-10-01' },
    { id: 'b', name: 'Land', status: 'held', valuation_paisa: '10000000', value_as_of: null },
  ],
  deductions: [
    { account: 'CHARITY_PAYABLE', balance_paisa: '2500000' },
    { account: 'MEMBER_ESCROW', balance_paisa: '500000' },
    { account: 'MEMBER_ADVANCE', balance_paisa: '200000' },
  ],
  stale_valuations: [],
};

describe('fundSplit', () => {
  it('adds up to the server net assets', () => {
    const s = fundSplit(nav);
    expect(s).toEqual({ cash: 13200000n, ownCash: 10200000n, invested: 40000000n, charity: 2500000n, levy: 0n, otherOwed: 500000n, advance: 200000n, total: 50200000n });
    // The advance stays in the total: it is the server's net assets plus the advance.
    expect(s.total).toBe(BigInt(nav.net_assets_paisa) + s.advance);
  });

  it('takes levy money held off the cash with the sadaqah', () => {
    const s = fundSplit({ ...nav, deductions: [...nav.deductions, { account: 'LEVY_CLEARING', balance_paisa: '30000' }] });
    expect(s.levy).toBe(30000n);
    expect(s.ownCash).toBe(10170000n);
    expect(s.otherOwed).toBe(500000n);
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
