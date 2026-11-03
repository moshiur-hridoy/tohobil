import { describe, expect, it } from 'vitest';
import { splitByCost, valuationVoteReason } from './schemas/asset';

const reason = (base: bigint, next: bigint, concernsAuditor = false, hasAuditor = true) =>
  valuationVoteReason({ base, next, concernsAuditor, hasAuditor });

describe('valuationVoteReason (ASSUMPTIONS 115)', () => {
  it('a rise of up to 10%, or no change, is for the auditor', () => {
    expect(reason(109_000_000n, 113_000_000n)).toBeNull(); // the owner's case: +৳40,000 on ৳10,90,000
    expect(reason(100n, 110n)).toBeNull();
    expect(reason(100n, 100n)).toBeNull();
  });
  it('a fall, a larger rise, the auditor involved, or no auditor goes to a vote', () => {
    expect(reason(100n, 99n)).toBe('fall');
    expect(reason(100n, 111n)).toBe('big_rise');
    expect(reason(0n, 1n)).toBe('big_rise');
    expect(reason(100n, 105n, true)).toBe('auditor');
    expect(reason(100n, 105n, false, false)).toBe('no_auditor');
  });
});

describe('splitByCost', () => {
  it('spreads the total by cost and the parts add up exactly', () => {
    const parts = splitByCost(100n, [{ id: 'a', cost_paisa: '1' }, { id: 'b', cost_paisa: 2n }, { id: 'c', cost_paisa: '0' }]);
    expect(parts).toEqual([{ asset_id: 'a', value_paisa: 33n }, { asset_id: 'b', value_paisa: 67n }]);
  });
});
