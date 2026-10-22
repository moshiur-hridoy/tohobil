import { formatDateDisplay, toDhakaDate } from '@barakah/shared';
import type { TFunction } from 'i18next';
import { getDigits, localDigits } from './format';

/** "২০ জানুয়ারি ২০২৬" (or "20 Jan 2026" with Western digits) for a YYYY-MM-DD business date. */
export function fmtDate(date: string): string {
  return formatDateDisplay(date, { digits: getDigits() });
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
  return fmtDate(`${period}-01`).replace(/^\S+\s+/, '');
}

/** "2026-11" as "নভে ২০২৬", only where a column is too narrow for the full name (the matrix header). */
export function fmtPeriodShort(period: string): string {
  return formatDateDisplay(`${period}-01`, { digits: getDigits(), shortMonth: true }).replace(/^\S+\s+/, '');
}

/** "21:30" as "রাত ৯:৩০": a 12-hour clock with the part of the day, the way people say it. */
export function fmtClock(t: TFunction, time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const part = h < 4 ? 'night' : h < 6 ? 'dawn' : h < 12 ? 'morning' : h < 15 ? 'noon' : h < 18 ? 'afternoon' : h < 20 ? 'evening' : 'night';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return t('meetings.clock', { part: t(`meetings.dayPart.${part}`), time: localDigits(`${h12}:${String(m).padStart(2, '0')}`) });
}
