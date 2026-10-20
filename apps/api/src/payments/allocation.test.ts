import { describe, expect, it } from 'vitest';
import { planDefaultAllocation, planManualAllocation } from './allocation';

const dues = [
  { id: 'd1', outstanding: 500_000n },
  { id: 'd2', outstanding: 500_000n },
];
const fines = [{ id: 'f1', outstanding: 100_000n }];

describe('planDefaultAllocation', () => {
  it('pays the oldest due first, then the next, then fines, then keeps credit', () => {
    const p = planDefaultAllocation(1_250_000n, dues, fines);
    expect(p.lines).toEqual([
      { due_id: 'd1', amount: 500_000n },
      { due_id: 'd2', amount: 500_000n },
      { fine_id: 'f1', amount: 100_000n },
    ]);
    expect(p.principal).toBe(1_000_000n);
    expect(p.fine).toBe(100_000n);
    expect(p.credit).toBe(150_000n);
  });

  it('a partial payment stops mid-due and touches no fine', () => {
    const p = planDefaultAllocation(300_000n, dues, fines);
    expect(p.lines).toEqual([{ due_id: 'd1', amount: 300_000n }]);
    expect(p.fine).toBe(0n);
    expect(p.credit).toBe(0n);
  });

  it('with nothing owed the whole payment is credit', () => {
    const p = planDefaultAllocation(70_000n, [], []);
    expect(p.lines).toEqual([]);
    expect(p.credit).toBe(70_000n);
  });

  it('components always add up to the amount', () => {
    for (const amount of [1n, 499_999n, 500_000n, 1_000_001n, 1_100_000n, 9_999_999n]) {
      const p = planDefaultAllocation(amount, dues, fines);
      expect(p.principal + p.fine + p.credit).toBe(amount);
    }
  });
});

describe('planManualAllocation', () => {
  it('accepts a valid list and keeps the rest as credit', () => {
    const p = planManualAllocation(
      700_000n,
      [{ fine_id: 'f1', amount_paisa: 100_000n }, { due_id: 'd2', amount_paisa: 200_000n }],
      dues,
      fines,
    );
    expect(p.fine).toBe(100_000n);
    expect(p.principal).toBe(200_000n);
    expect(p.credit).toBe(400_000n);
  });

  it('merges repeated targets before checking the outstanding amount', () => {
    expect(() =>
      planManualAllocation(
        900_000n,
        [{ due_id: 'd1', amount_paisa: 300_000n }, { due_id: 'd1', amount_paisa: 300_000n }],
        dues,
        fines,
      ),
    ).toThrow(/larger than what is still owed/);
  });

  it('rejects unknown or closed targets, over-allocation and totals above the payment', () => {
    expect(() =>
      planManualAllocation(1n, [{ due_id: 'other', amount_paisa: 1n }], dues, fines),
    ).toThrow(/not open for this member/);
    expect(() =>
      planManualAllocation(
        100_000n,
        [{ due_id: 'd1', amount_paisa: 60_000n }, { due_id: 'd2', amount_paisa: 60_000n }],
        dues,
        fines,
      ),
    ).toThrow(/exceed the payment amount/);
  });

  it('an empty list means everything becomes credit', () => {
    const p = planManualAllocation(100_000n, [], dues, fines);
    expect(p.lines).toEqual([]);
    expect(p.credit).toBe(100_000n);
  });
});
