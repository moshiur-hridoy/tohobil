import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCount } from './format';

export function useCountdown(target: string | null): string | null {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!target) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [target]);

  if (!target) return null;
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return t('votes.closed');

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return t('votes.remainingDays', { days: formatCount(days), hours: formatCount(hours % 24) });
  }
  return t('votes.remainingHours', { hours: formatCount(hours), minutes: formatCount(minutes) });
}
