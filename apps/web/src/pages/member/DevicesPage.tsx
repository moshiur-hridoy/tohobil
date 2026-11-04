import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toDhakaDate } from '@barakah/shared';
import { Chip, PageHeader } from '../../components/ui';
import { LoadError } from '../../components/StateViews';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { api } from '../../lib/api';
import { daysBetween, fmtDate, fmtInstant, todayDhaka } from '../../lib/dates';
import { deviceName, isPhone } from '../../lib/device';

export interface DeviceRow {
  id: string;
  label: string | null;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  current: boolean;
}

/** A device not used for this many days gets a "not used for N days" note, a hint that it may be old. */
const IDLE_DAYS = 30;
const PHONE = 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M11 18h2';
const COMPUTER = 'M3 5h18v11H3z M8 20h8 M12 16v4';

/** "আমার ডিভাইস": where the member's account is signed in, with a way to sign out of any of them. */
export function DevicesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<{ items: DeviceRow[] }>('/me/devices') });
  const [removing, setRemoving] = useState<DeviceRow | null>(null);
  const [removeOthers, setRemoveOthers] = useState(false);

  const revoke = useMutation({
    mutationFn: async (ids: string[]) => {
      // One request per device; each leaves its own "device switched off" line in the security feed.
      for (const id of ids) await api(`/me/devices/${id}`, { method: 'DELETE' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['device-events'] });
    },
  });

  const items = devices.data?.items ?? [];
  // This device first, then the most recently used.
  const sorted = [...items].sort((a, b) => Number(b.current) - Number(a.current) || (b.last_seen_at ?? b.created_at).localeCompare(a.last_seen_at ?? a.created_at));
  const others = items.filter((d) => !d.current);
  const today = todayDhaka();

  const when = (iso: string): string => {
    const days = daysBetween(toDhakaDate(new Date(iso)), today);
    return days <= 0 ? t('relDay.today') : days === 1 ? t('relDay.yesterday') : fmtInstant(iso);
  };

  return (
    <div>
      <PageHeader title={t('devices.title')} subtitle={t('devices.hint')} back="/menu" />
      <div className="flex flex-col gap-3 px-4 pb-6 pt-1">
        {devices.error && <LoadError error={devices.error} onRetry={() => void devices.refetch()} />}

        <ul className="divide-y divide-border overflow-clip rounded-[20px] border border-border bg-card">
          {sorted.map((d) => {
            const lastUsed = d.last_seen_at ?? d.created_at;
            const idle = daysBetween(toDhakaDate(new Date(lastUsed)), today);
            const name = deviceName(t, d.label, d.platform);
            return (
              <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                <Chip tone={d.current ? 'bg-primary-soft text-primary' : 'bg-soft text-muted'} d={isPhone(d.label, d.platform) ? PHONE : COMPUTER} size={40} iconSize={20} />
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{name}</p>
                  <p className="text-sm text-muted">
                    {t('devices.lastUsed', { when: when(lastUsed) })} · {t('devices.added', { date: fmtDate(toDhakaDate(new Date(d.created_at))) })}
                  </p>
                  {d.current ? (
                    <span className="mt-1 inline-block rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-primary">{t('menu.thisDevice')}</span>
                  ) : (
                    idle >= IDLE_DAYS && <span className="mt-1 inline-block rounded-full bg-warn-bg px-2.5 py-0.5 text-xs font-semibold text-warn">{t('devices.idle', { days: idle })}</span>
                  )}
                </div>
                {!d.current && (
                  <button type="button" onClick={() => setRemoving(d)} className="min-h-11 shrink-0 rounded-xl border border-border px-3 text-sm font-semibold text-bad">
                    {t('devices.remove')}
                  </button>
                )}
              </li>
            );
          })}
          {devices.data && others.length === 0 && <li className="px-4 py-3 text-sm text-muted">{t('devices.onlyThis')}</li>}
        </ul>

        {others.length > 0 && (
          <button type="button" onClick={() => setRemoveOthers(true)} className="min-h-12 rounded-2xl border border-border bg-card font-semibold text-bad">
            {t('devices.removeOthers')}
          </button>
        )}

        <p className="px-1 text-sm text-muted">
          {t('devices.pinTip')}{' '}
          <Link to="/menu/pin" className="font-semibold text-primary underline">
            {t('pinChange.title')}
          </Link>
        </p>
      </div>

      <ConfirmSheet
        open={removing != null}
        onClose={() => setRemoving(null)}
        title={t('devices.removeTitle')}
        confirmLabel={t('devices.remove')}
        tone="danger"
        onConfirm={() => revoke.mutateAsync(removing ? [removing.id] : [])}
      >
        <p>{t('devices.removeBody', { name: removing ? deviceName(t, removing.label, removing.platform) : '' })}</p>
      </ConfirmSheet>
      <ConfirmSheet
        open={removeOthers}
        onClose={() => setRemoveOthers(false)}
        title={t('devices.removeOthersTitle')}
        confirmLabel={t('devices.removeOthersConfirm')}
        tone="danger"
        onConfirm={() => revoke.mutateAsync(others.map((d) => d.id))}
      >
        <p>{t('devices.removeOthersBody', { count: others.length })}</p>
      </ConfirmSheet>
    </div>
  );
}
