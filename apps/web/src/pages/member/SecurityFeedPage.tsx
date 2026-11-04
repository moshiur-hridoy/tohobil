import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toDhakaDate } from '@barakah/shared';
import { Chip, PageHeader } from '../../components/ui';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { daysBetween, dhakaTime, fmtClock, fmtDate, todayDhaka } from '../../lib/dates';

interface DeviceEvent {
  id: string;
  kind: 'registered' | 'revoked' | 'reset';
  at: string;
  member_code: string;
  full_name: string;
}

const KIND = {
  registered: { tone: 'bg-primary-soft text-primary', d: 'M12 5v14 M5 12h14' },
  revoked: { tone: 'bg-bad-bg text-bad', d: 'M6 6l12 12 M18 6L6 18' },
  reset: { tone: 'bg-warn-bg text-warn', d: 'M4 4v6h6 M20 20v-6h-6 M5.6 15a7 7 0 0 0 11.8 2.4 M18.4 9A7 7 0 0 0 6.6 6.6' },
} as const;

/**
 * "নিরাপত্তা ফিড" (spec 19.1): every member can see when anyone's device was added, removed or reset,
 * newest first, grouped by day, with the member's name. The viewer's own lines are marked "আপনি".
 */
export function SecurityFeedPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const events = useQuery({ queryKey: ['device-events'], queryFn: () => api<{ items: DeviceEvent[] }>('/device-events') });
  const today = todayDhaka();

  const groups: Array<{ day: string; items: DeviceEvent[] }> = [];
  for (const e of events.data?.items ?? []) {
    const day = toDhakaDate(new Date(e.at));
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  const dayTitle = (day: string): string => {
    const ago = daysBetween(day, today);
    return ago <= 0 ? t('relDay.today') : ago === 1 ? t('relDay.yesterday') : fmtDate(day);
  };

  return (
    <div>
      <PageHeader title={t('menu.securityFeed')} subtitle={t('menu.securityFeedHint')} back="/menu" />
      <div className="flex flex-col gap-4 px-4 pb-6 pt-1">
        {events.error && <LoadError error={events.error} onRetry={() => void events.refetch()} />}
        {events.data?.items.length === 0 && <Empty text={t('menu.noEvents')} />}
        {groups.map((g) => (
          <section key={g.day}>
            <h2 className="px-1 pb-2 text-sm font-semibold text-muted">{dayTitle(g.day)}</h2>
            <ul className="divide-y divide-border overflow-clip rounded-[20px] border border-border bg-card">
              {g.items.map((e) => {
                const mine = e.member_code === me?.member_code;
                return (
                  <li key={e.id} className={`flex items-center gap-3 px-4 py-3 ${mine ? 'bg-soft' : ''}`}>
                    <Chip tone={KIND[e.kind].tone} d={KIND[e.kind].d} size={36} iconSize={18} />
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium">
                        {e.full_name} <span className="font-normal text-muted">· {e.member_code}</span>
                        {mine && <span className="ml-2 inline-block rounded-full bg-primary px-2 py-0.5 align-middle text-xs font-semibold text-primary-foreground">{t('securityFeed.you')}</span>}
                      </p>
                      <p className="text-sm text-muted">
                        {t(`menu.deviceEvent.${e.kind}`)} · <time dateTime={e.at}>{fmtClock(t, dhakaTime(e.at))}</time>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
