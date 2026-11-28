import { describe, expect, it } from 'vitest';
import { FILL_ORDER, bkashGross, bkashNet, fillRows } from './sendMoney';

describe('bKash charge', () => {
  it('takes ৳18.50 per ৳1,000 of what reaches the fund', () => {
    expect(bkashGross(1_000_000n)).toBe(1_018_500n); // ৳10,000 → send ৳10,185
    expect(bkashNet(1_018_500n)).toBe(1_000_000n);
    expect(bkashNet(1_500_000n)).toBe(1_472_754n); // ৳15,000 sent → ৳14,727.54
  });

  it('gives back exactly the amount the charge was added to', () => {
    for (let net = 1n; net < 30_000n; net += 7n) expect(bkashNet(bkashGross(net))).toBe(net);
    expect(bkashNet(bkashGross(123_456_789n))).toBe(123_456_789n);
  });
});

describe('fillRows', () => {
  const parts = [
    { key: 'dec', amount: 1_000_000n, order: FILL_ORDER.notYetDue },
    { key: 'nov', amount: 1_000_000n, order: FILL_ORDER.due },
    { key: 'nov', amount: 50_000n, order: FILL_ORDER.fine },
    { key: 'jan', amount: 1_000_000n, order: FILL_ORDER.noDueYet },
  ];

  it('pays the month due first and carries the rest to the next month', () => {
    const { covered, fines, leftover } = fillRows(parts, 1_472_754n);
    expect(fines).toBe(50_000n);
    expect(covered.get('nov')).toBe(1_050_000n);
    expect(covered.get('dec')).toBe(422_754n);
    expect(covered.has('jan')).toBe(false);
    expect(leftover).toBe(0n);
  });

  it('pays dues before fines, and fines before months not yet due', () => {
    expect(fillRows(parts, 1_020_000n).covered).toEqual(new Map([['nov', 1_020_000n]]));
  });

  it('reports what no row can take', () => {
    expect(fillRows(parts, 3_100_000n).leftover).toBe(50_000n);
  });
});
