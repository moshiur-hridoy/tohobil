/**
 * Date utilities. All business dates are in Asia/Dhaka (UTC+6, no DST).
 * DB stores timestamptz (UTC). Business dates are `date` columns, represented here as 'YYYY-MM-DD'
 * strings: never as JS Date objects, which would shift them by the machine's time zone.
 */

import { toBengaliDigits, type DigitSystem } from './money';

const DHAKA_TZ = 'Asia/Dhaka';

const dhakaDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: DHAKA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The Asia/Dhaka calendar date ('YYYY-MM-DD') of an instant.
 */
export function toDhakaDate(instant: Date): string {
  const parts = dhakaDateFormat.formatToParts(instant);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * Injectable clock interface. Everything that depends on "now" takes one so tests can simulate months.
 */
export interface Clock {
  now(): Date;
  todayDhaka(): string; // YYYY-MM-DD
}

/**
 * Default clock using system time.
 */
export const systemClock: Clock = {
  now: () => new Date(),
  todayDhaka: () => toDhakaDate(new Date()),
};

/**
 * Create a fake clock for testing.
 */
export function createFakeClock(
  initial: Date,
): Clock & { advance(ms: number): void; set(date: Date): void } {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    todayDhaka: () => toDhakaDate(current),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    set: (date: Date) => {
      current = new Date(date);
    },
  };
}

/**
 * Get today's date in Asia/Dhaka as YYYY-MM-DD.
 */
export function todayDhaka(clock: Clock = systemClock): string {
  return clock.todayDhaka();
}

/**
 * Get the current period (YYYY-MM) in Asia/Dhaka.
 */
export function currentPeriod(clock: Clock = systemClock): string {
  return todayDhaka(clock).slice(0, 7);
}

/**
 * True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30, 2026-13-01).
 */
export function isValidIsoDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one. UTC avoids any local-time effects.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Get the first day of a period.
 */
export function periodStart(period: string): string {
  return `${period}-01`;
}

/**
 * Get the last day of a period.
 */
export function periodEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return `${period}-${String(daysInMonth(year as number, month as number)).padStart(2, '0')}`;
}

/**
 * The date of `day` within `period`, clamped to the month's length (day 31 of a 30-day month is the
 * 30th). Used for due dates, so a rule value can never produce a non-existent date.
 */
export function dateInPeriod(period: string, day: number): string {
  const lastDay = Number(periodEnd(period).slice(8));
  const clamped = Math.min(Math.max(Math.trunc(day), 1), lastDay);
  return `${period}-${String(clamped).padStart(2, '0')}`;
}

/**
 * Add months to a period string (negative values go back).
 */
export function addMonths(period: string, months: number): string {
  const [year, month] = period.split('-').map(Number);
  const totalMonths = (year as number) * 12 + ((month as number) - 1) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (((totalMonths % 12) + 12) % 12) + 1;
  return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}`;
}

/**
 * Check if a date string is in a given period.
 */
export function isInPeriod(dateStr: string, period: string): boolean {
  return dateStr.startsWith(period);
}

const BN_MONTHS = [
  'জানুয়ারি',
  'ফেব্রুয়ারি',
  'মার্চ',
  'এপ্রিল',
  'মে',
  'জুন',
  'জুলাই',
  'আগস্ট',
  'সেপ্টেম্বর',
  'অক্টোবর',
  'নভেম্বর',
  'ডিসেম্বর',
] as const;

/**
 * Format a YYYY-MM-DD date for display in Bengali ("২০ জানুয়ারি ২০২৬"). The `digits` setting
 * switches between Bengali and Western numerals (spec 8).
 */
export function formatDateBn(dateStr: string, opts: { digits?: DigitSystem } = {}): string {
  const { digits = 'bn' } = opts;
  const [year, month, day] = dateStr.split('-').map(Number);
  const text = `${day} ${BN_MONTHS[(month as number) - 1]} ${year}`;
  return digits === 'bn' ? toBengaliDigits(text) : text;
}

const BN_MONTHS_SHORT = ['জানু', 'ফেব্রু', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টে', 'অক্টো', 'নভে', 'ডিসে'] as const;
const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Format a YYYY-MM-DD date for the screen: "২২ অক্টোবর ২০২৬" with Bengali digits, "22 Oct 2026" with
 * Western ones (the month follows the numerals so the two never mix). `shortMonth` gives "২২ অক্টো ২০২৬"
 * for the few places too narrow for the full Bengali name.
 */
export function formatDateDisplay(dateStr: string, opts: { digits?: DigitSystem; shortMonth?: boolean } = {}): string {
  const { digits = 'bn', shortMonth = false } = opts;
  const [year, month, day] = dateStr.split('-').map(Number);
  const i = (month as number) - 1;
  return digits === 'bn' ? toBengaliDigits(`${day} ${(shortMonth ? BN_MONTHS_SHORT : BN_MONTHS)[i]} ${year}`) : `${day} ${EN_MONTHS_SHORT[i]} ${year}`;
}

/**
 * Parse a date from DD/MM/YYYY format (used in bKash SMS). Returns YYYY-MM-DD or null when the
 * text has no valid calendar date.
 */
export function parseDDMMYYYY(text: string): string | null {
  const match = /(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  return isValidIsoDate(iso) ? iso : null;
}

const MONTH_NUMBERS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/**
 * Parse a date from DD-Mon-YYYY format (used in bank SMS). Month names are case-insensitive.
 * Returns YYYY-MM-DD or null.
 */
export function parseDDMonYYYY(text: string): string | null {
  const match = /(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  if (!match) return null;
  const [, dd, mon, yyyy] = match;
  const mm = MONTH_NUMBERS[(mon as string).toLowerCase()];
  if (!mm) return null;
  const iso = `${yyyy}-${mm}-${dd}`;
  return isValidIsoDate(iso) ? iso : null;
}
