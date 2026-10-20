import { formatDateBn, toDhakaDate } from '@barakah/shared';
import { getDigits } from './format';

/** "২০ জানুয়ারি ২০২৬" for a YYYY-MM-DD business date. */
export function fmtDate(date: string): string {
  return formatDateBn(date, { digits: getDigits() });
}

/** An ISO timestamp shown as its Asia/Dhaka business date. */
export function fmtInstant(iso: string): string {
  return fmtDate(toDhakaDate(new Date(iso)));
}

/** Today's Asia/Dhaka date, for `<input type="date">` defaults and max values. */
export function todayDhaka(): string {
  return toDhakaDate(new Date());
}

/** Dhaka midnight-based ISO timestamp for a chosen day at the current time of day. */
export function dayToIso(date: string): string {
  const now = new Date();
  if (date === toDhakaDate(now)) return now.toISOString();
  return `${date}T12:00:00+06:00`;
}

/** "2026-11" as "নভেম্বর ২০২৬" (month and year of a period). */
export function fmtPeriod(period: string): string {
  const text = formatDateBn(`${period}-01`, { digits: getDigits() });
  return text.replace(/^\S+\s+/, '');
}
