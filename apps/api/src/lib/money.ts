/**
 * Money plumbing for the API layer. Paisa is `bigint` inside the process and a decimal string on the
 * wire (JSON has no bigint, spec 4).
 *
 * Production pools parse int8 into bigint (see `createPool`), but a plain `pg.Pool` returns strings,
 * so code that reads money from SQL goes through `toBigInt` and never depends on the pool's parser.
 */

/** Convert an int8/numeric column value (bigint, digit string or safe integer) to bigint. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`Not an integer amount: ${String(value)}`);
}

/** Wire form of a paisa amount: a decimal string. */
export function paisaOut(value: unknown): string {
  return toBigInt(value).toString();
}
