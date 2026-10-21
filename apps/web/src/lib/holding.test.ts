import { describe, expect, it } from 'vitest';
import { holdingTotals, splitByCost } from './holding';
import type { AssetRow } from './types';

const asset = (cost: string, value: string | null, status: AssetRow['status'] = 'held', asOf: string | null = null) =>
  ({ id: cost, cost_paisa: cost, latest_value_paisa: value, latest_value_as_of: asOf, status }) as AssetRow;

describe('holding', () => {
  it('totals invest, value (cost when unvalued) and profit', () => {
    const t = holdingTotals([asset('1000', '1300', 'held', '2026-10-01'), asset('2000', null), asset('500', '900', 'sold')]);
    expect(t).toMatchObject({ invested: 3000n, value: 3300n, profit: 300n, lastValued: '2026-10-01', count: 2 });
  });

  it('splits a total by cost without losing a paisa', () => {
    const parts = splitByCost(1000n, [{ id: 'a', cost_paisa: '1' }, { id: 'b', cost_paisa: '1' }, { id: 'c', cost_paisa: '1' }, { id: 'z', cost_paisa: '0' }]);
    expect(parts.map((p) => p.asset_id)).toEqual(['a', 'b', 'c']);
    expect(parts.reduce((a, p) => a + p.value_paisa, 0n)).toBe(1000n);
  });
});
