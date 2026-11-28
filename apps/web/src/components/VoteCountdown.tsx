import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Icon } from './ui';
import { splitTimeLeft, twoDigits, useTimeLeft } from '../lib/countdown';
import { dhakaTime, fmtClock, fmtInstant } from '../lib/dates';
import { formatCount } from '../lib/format';

const CLOCK = 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2';
/** Under this much time left the card turns to the warning colours. */
const URGENT_MS = 60 * 60 * 1000;

/** "২০ জানুয়ারি, রাত ১০:০০": the date and the Dhaka clock time a vote closes. */
export function closesAtText(t: TFunction, iso: string): string {
  return `${fmtInstant(iso)}, ${fmtClock(t, dhakaTime(iso))}`;
}

/**
 * The vote page's live countdown to `closesAt`: one strip across the top of the proposal card, on the
 * dark brand colour (the warning colours in the last hour).
 */
export function VoteCountdown({ closesAt }: { closesAt: string }) {
  const { t } = useTranslation();
  const ms = useTimeLeft(closesAt) ?? 0;
  const left = splitTimeLeft(ms);
  return (
    <div
      data-testid="vote-countdown"
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-hero px-4 py-3 text-on-hero ${left && ms < URGENT_MS ? 'hero-alert' : ''}`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <Icon d={CLOCK} size={18} />
        {left ? t('votes.countdown.title') : t('votes.countdown.over')}
      </span>
      {left && (
        <>
          {/* Screen readers get one sentence, not a number changing every second. */}
          <span className="sr-only">
            {t('votes.countdown.sr', { days: formatCount(left.days), hours: formatCount(left.hours), minutes: formatCount(left.minutes) })}
          </span>
          <span aria-hidden="true" className="ml-auto text-xl font-bold tabular-nums">
            {left.days > 0 && <span className="mr-3">{formatCount(left.days)} {t('votes.countdown.days')}</span>}
            {twoDigits(left.hours)} : {twoDigits(left.minutes)} : {twoDigits(left.seconds)}
          </span>
        </>
      )}
    </div>
  );
}

/** "২ দিন ০৫:১২:০৯ বাকি" ticking every second, for a vote's card in a list (members and cashier). */
export function CountdownChip({ closesAt }: { closesAt: string }) {
  const { t } = useTranslation();
  const left = splitTimeLeft(useTimeLeft(closesAt) ?? 0);
  if (!left) return <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-muted">{t('votes.countdown.over')}</span>;
  const clock = `${twoDigits(left.hours)}:${twoDigits(left.minutes)}:${twoDigits(left.seconds)}`;
  const urgent = left.days === 0 && left.hours === 0;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${urgent ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn'}`}>
      <Icon d={CLOCK} size={14} sw={2} />
      {left.days > 0 ? t('votes.countdown.chipDays', { days: formatCount(left.days), clock }) : t('votes.countdown.chip', { clock })}
    </span>
  );
}
