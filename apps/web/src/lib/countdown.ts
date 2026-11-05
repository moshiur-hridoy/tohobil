import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCount, localDigits } from './format';

/** Time left split for a countdown clock. */
export interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Splits milliseconds left into whole days, hours, minutes and seconds; null once the time is up. */
export function splitTimeLeft(ms: number): TimeLeft | null {
  if (ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/** A clock part as two digits in the user's numerals ("০৫" or "05"). */
export const twoDigits = (n: number): string => localDigits(String(n).padStart(2, '0'));

/**
 * Milliseconds left until `target`, re-rendered every `stepMs` (every second for a ticking clock).
 * Null without a target. Never negative.
 */
export function useTimeLeft(target: string | null, stepMs = 1000): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(timer);
  }, [target, stepMs]);
  if (!target) return null;
  return Math.max(0, new Date(target).getTime() - now);
}

/** "২ দিন ৫ ঘণ্টা" or "৩ ঘণ্টা ১২ মিনিট" left, updated every minute; "বন্ধ" once the time is up. */
export function useCountdown(target: string | null): string | null {
  const { t } = useTranslation();
  const ms = useTimeLeft(target, 60_000);
  if (ms === null) return null;
  const left = splitTimeLeft(ms);
  if (!left) return t('votes.closed');
  if (left.days > 0) return t('votes.remainingDays', { days: formatCount(left.days), hours: formatCount(left.hours) });
  return t('votes.remainingHours', { hours: formatCount(left.hours), minutes: formatCount(left.minutes) });
}
