import { PHONE_PATTERN, toWesternDigits } from '@barakah/shared';

/**
 * A Bangladeshi mobile number typed the way people write it ("01712-345678", "+880 1712 345678",
 * Bengali digits) as the stored form "+8801712345678", or null if it is not one.
 */
export function phoneFromInput(raw: string): string | null {
  const digits = toWesternDigits(raw).replace(/\D/g, '');
  const full = /^01\d{9}$/.test(digits) ? `+88${digits}` : /^8801\d{9}$/.test(digits) ? `+${digits}` : null;
  return full && PHONE_PATTERN.test(full) ? full : null;
}

/** "+8801712345678" as "01712345678", the way it is typed and read out. */
export function phoneForInput(stored: string): string {
  return stored.startsWith('+88') ? stored.slice(3) : stored;
}
