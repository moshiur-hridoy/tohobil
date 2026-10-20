import type pg from 'pg';
import type { Clock } from '@barakah/shared';

export async function ruleValue(
  pool: pg.Pool,
  clock: Clock,
  key: string,
): Promise<string | number | boolean | undefined> {
  const res = await pool.query(
    `SELECT value FROM rules WHERE key = $1 AND valid_from <= $2 ORDER BY valid_from DESC LIMIT 1`,
    [key, clock.todayDhaka()],
  );
  return (res.rows[0] as { value: string | number | boolean } | undefined)?.value;
}

export async function ruleInt(pool: pg.Pool, clock: Clock, key: string, fallback: number): Promise<number> {
  const value = await ruleValue(pool, clock, key);
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

export async function ruleBool(pool: pg.Pool, clock: Clock, key: string, fallback: boolean): Promise<boolean> {
  const value = await ruleValue(pool, clock, key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

export async function ruleString(pool: pg.Pool, clock: Clock, key: string, fallback: string): Promise<string> {
  const value = await ruleValue(pool, clock, key);
  return typeof value === 'string' ? value : fallback;
}

/** Format a period from a Dhaka date. */
export function periodFromDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return `${get('year')}-${get('month')}`;
}

/** Is today the given day-of-month in Asia/Dhaka? */
export function isDay(date: Date, day: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'day')?.value) === day;
}

/** Is today between startDay and endDay inclusive in Asia/Dhaka? */
export function isWindow(date: Date, startDay: number, endDay: number): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
  }).formatToParts(date);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  return day >= startDay && day <= endDay;
}
