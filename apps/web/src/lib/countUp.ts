/** How long an amount takes to count up to its value (components/AnimatedTaka.tsx). */
export const COUNT_UP_MS = 1200;

/** Fast at first, then a long slow finish: the last digits tick into place, like a counter coming to rest. */
export const easeOutQuint = (t: number): number => 1 - (1 - t) ** 5;

/**
 * The amount to show at `t` (0 to 1) of the way from `from` to `to`. Display only and bigint
 * throughout: the eased fraction becomes a whole number of millionths, never a float amount (fine
 * enough that the slow finish still moves the last digits).
 * Amounts on the way are whole taka, so the paisa digits do not flicker; at the end it is exactly `to`.
 */
export function paisaAt(from: bigint, to: bigint, t: number): bigint {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const millionths = BigInt(Math.round(easeOutQuint(t) * 1_000_000));
  const value = from + ((to - from) * millionths) / 1_000_000n;
  return value - (value % 100n);
}
