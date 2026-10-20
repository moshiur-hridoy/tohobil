/**
 * Money utilities for BDT (Bangladeshi Taka).
 * All amounts are stored as bigint paisa (1 BDT = 100 paisa).
 * Never use floating point for money.
 */

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const;

export type DigitSystem = 'bn' | 'en';

/**
 * Convert Western digits in a string to Bengali digits.
 */
export function toBengaliDigits(str: string): string {
  return str.replace(/[0-9]/g, (d) => BENGALI_DIGITS[d.charCodeAt(0) - 48] as string);
}

/**
 * Convert Bengali digits (U+09E6..U+09EF) in a string to Western digits.
 */
export function toWesternDigits(str: string): string {
  return str.replace(/[\u09E6-\u09EF]/g, (d) => String(d.charCodeAt(0) - 0x09e6));
}

/**
 * Format paisa as BDT with lakh/crore grouping.
 * Examples:
 *   500000 paisa -> "৫,০০০" (bn) or "5,000" (en)
 *   10000000 paisa -> "১,০০,০০০" (bn) or "1,00,000" (en)
 *   100000000 paisa -> "১০,০০,০০০" (bn) or "10,00,000" (en)
 */
export function formatBDT(
  paisa: bigint,
  opts: { digits?: DigitSystem; showPaisa?: boolean } = {},
): string {
  const { digits = 'bn', showPaisa = false } = opts;
  const isNegative = paisa < 0n;
  const absPaisa = isNegative ? -paisa : paisa;

  const taka = absPaisa / 100n;
  const remainderPaisa = absPaisa % 100n;

  let takaStr = taka.toString();

  // Apply lakh/crore grouping (Indian numbering system)
  takaStr = groupLakhCrore(takaStr);

  let result = takaStr;

  if (showPaisa && remainderPaisa > 0n) {
    const paisaStr = remainderPaisa.toString().padStart(2, '0');
    result += '.' + paisaStr;
  }

  if (isNegative) {
    result = '-' + result;
  }

  if (digits === 'bn') {
    result = toBengaliDigits(result);
  }

  return result;
}

/**
 * Group a number string using lakh/crore (Indian) system.
 * 1234567 -> "12,34,567"
 * 12345678 -> "1,23,45,678"
 */
function groupLakhCrore(numStr: string): string {
  if (numStr.length <= 3) return numStr;

  // Last 3 digits
  const last3 = numStr.slice(-3);
  const rest = numStr.slice(0, -3);

  // Group the rest in pairs from the right
  const grouped: string[] = [];
  let remaining = rest;
  while (remaining.length > 2) {
    grouped.unshift(remaining.slice(-2));
    remaining = remaining.slice(0, -2);
  }
  if (remaining.length > 0) {
    grouped.unshift(remaining);
  }

  return [...grouped, last3].join(',');
}

/**
 * Parse a BDT string to paisa (bigint). Strict: anything that is not an amount throws, because a
 * silently-wrong amount is worse than a rejected one.
 *
 * Accepts: commas (any grouping), the ৳ symbol, "Tk"/"Tk."/"BDT", Bengali digits, spaces, a leading
 * minus, and at most two decimal places.
 * Examples: "৳5,000", "5000", "৫,০০০", "1,00,000.50", "Tk. 15,500", "-5,000.50".
 *
 * @throws RangeError when the text is not a valid amount (empty, letters, 3+ decimals, "1.2.3").
 */
export function parseBDT(text: string): bigint {
  const parsed = tryParseBDT(text);
  if (parsed === null) {
    throw new RangeError(`Invalid BDT amount: ${JSON.stringify(text)}`);
  }
  return parsed;
}

/**
 * Like {@link parseBDT} but returns null instead of throwing (used by the SMS parser, which must
 * never throw).
 */
export function tryParseBDT(text: string): bigint | null {
  const cleaned = toWesternDigits(text)
    .replace(/৳/g, '')
    .replace(/\b(?:Tk|BDT)\.?/gi, '')
    .replace(/[,\s]/g, '');

  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  const paisa = BigInt(whole as string) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -paisa : paisa;
}

/**
 * Integer division, rounding half away from zero (symmetric): divRound(-a, b) === -divRound(a, b).
 * For positive inputs this is exactly "round half up". The symmetry is deliberate: a reversal of a
 * computed amount must net to zero. Always multiply before dividing to avoid precision loss.
 *
 * @throws RangeError on division by zero.
 */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('Division by zero');

  const isNegative = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;

  const quotient = absA / absB;
  const remainder = absA % absB;

  // Round half up: if remainder * 2 >= divisor, round up
  const rounded = remainder * 2n >= absB ? quotient + 1n : quotient;

  return isNegative ? -rounded : rounded;
}

/**
 * Format paisa for display in notifications (short form).
 */
export function formatBDTShort(paisa: bigint, digits: DigitSystem = 'bn'): string {
  return '৳' + formatBDT(paisa, { digits });
}
