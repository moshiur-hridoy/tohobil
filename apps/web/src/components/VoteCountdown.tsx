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
 * The vote page's live countdown to `closesAt`: days, hours, minutes and seconds ticking down on the
 * dark brand card (the warning colours in the last hour), with the closing date and time under it.
 */
export function VoteCountdown({ closesAt }: { closesAt: string }) {
  const { t } = useTranslation();
  const ms = useTimeLeft(closesAt) ?? 0;
  const left = splitTimeLeft(ms);
  const parts = left
    ? ([
        ['days', left.days],
        ['hours', left.hours],
        ['minutes', left.minutes],
        ['seconds', left.seconds],
      ] as const)
    : null;
  return (
    <section
      data-testid="vote-countdown"
      className={`relative overflow-hidden rounded-3xl bg-hero p-4 text-on-hero ${left && ms < URGENT_MS ? 'hero-alert' : ''}`}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(70% 70% at 90% 0%, var(--hero-icon) 0%, transparent 70%)' }} />
      <div className="relative">
        <div className="flex items-center gap-2 text-sm text-on-hero-muted">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-hero-icon text-hero-action">
            <Icon d={CLOCK} size={18} />
          </span>
          <span className="flex-1 font-semibold text-on-hero">{parts ? t('votes.countdown.title') : t('votes.countdown.over')}</span>
        </div>
        {parts ? (
          <>
            {/* Screen readers get one sentence, not a number changing every second. */}
            <p className="sr-only">
              {t('votes.countdown.sr', { days: formatCount(left!.days), hours: formatCount(left!.hours), minutes: formatCount(left!.minutes) })}
            </p>
            <div aria-hidden="true" className="mt-3 grid grid-cols-4 gap-2">
              {parts.map(([unit, n]) => (
                <div key={unit} className="rounded-2xl bg-hero-chip px-1 py-2.5 text-center">
                  <div className="text-[1.75rem] font-bold leading-none tabular-nums">{unit === 'days' ? formatCount(n) : twoDigits(n)}</div>
                  <div className="mt-1.5 text-xs text-on-hero-muted">{t(`votes.countdown.${unit}`)}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-on-hero-muted">{t('votes.countdown.counting')}</p>
        )}
        <p className="mt-3 text-sm text-on-hero-muted">{t('votes.countdown.closesAt', { when: closesAtText(t, closesAt) })}</p>
      </div>
    </section>
  );
}

/** "২ দিন ০৫:১২:০৯ বাকি" ticking every second, for a vote's card in the list. */
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
