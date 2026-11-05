import { describe, expect, it } from 'vitest';
import { easeOutQuint, paisaAt } from './countUp';

describe('paisaAt', () => {
  it('starts at the old amount and ends exactly at the new one, paisa included', () => {
    expect(paisaAt(0n, 2_000_050n, 0)).toBe(0n);
    expect(paisaAt(0n, 2_000_050n, 1)).toBe(2_000_050n);
    expect(paisaAt(150_000n, 99n, 1)).toBe(99n);
  });

  it('shows whole taka on the way, so the paisa digits do not flicker', () => {
    for (const t of [0.1, 0.25, 0.5, 0.9]) expect(paisaAt(0n, 2_000_050n, t) % 100n).toBe(0n);
  });

  it('only rises on the way up and only falls on the way down', () => {
    const up = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => paisaAt(0n, 5_000_000n, t));
    const down = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => paisaAt(5_000_000n, 100_000n, t));
    up.slice(1).forEach((v, i) => expect(v >= up[i]!).toBe(true));
    down.slice(1).forEach((v, i) => expect(v <= down[i]!).toBe(true));
  });

  it('still moves near the end, so the last digits tick into place', () => {
    const late = paisaAt(0n, 95_100_000n, 0.85);
    expect(late).toBeLessThan(95_100_000n);
    expect(late).toBeGreaterThan(95_000_000n);
  });

  it('counts towards a negative amount too', () => {
    expect(paisaAt(0n, -300_000n, 1)).toBe(-300_000n);
    expect(paisaAt(0n, -300_000n, 0.5) < 0n).toBe(true);
  });
});

describe('easeOutQuint', () => {
  it('runs from 0 to 1 and is past halfway at the midpoint', () => {
    expect(easeOutQuint(0)).toBe(0);
    expect(easeOutQuint(1)).toBe(1);
    expect(easeOutQuint(0.5)).toBeGreaterThan(0.5);
  });

  it('spends the last third of the time on the last few digits (the slow finish)', () => {
    expect(easeOutQuint(2 / 3)).toBeGreaterThan(0.99);
  });
});
