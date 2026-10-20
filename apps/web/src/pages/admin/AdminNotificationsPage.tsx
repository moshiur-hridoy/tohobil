import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtInstant } from '../../lib/dates';
import type { MemberRow, Page } from '../../lib/types';

interface AdminNotification {
  id: string;
  member_id: string;
  template: string;
  channel: 'push' | 'sms';
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  scheduled_for: string;
  sent_at: string | null;
  opened_at: string | null;
  error: string | null;
}

interface Unreachable {
  member_id: string;
  code: string;
  full_name: string;
  reason: 'push_disabled' | 'no_push_token' | 'recent_push_unopened';
}

const TEMPLATES = ['due_reminder', 'fine_notice', 'payment_confirmed', 'payment_rejected', 'final_notice', 'device_event'];

/** Cashier and auditor: who cannot be reached by push, and what the system has sent. */
export function AdminNotificationsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [template, setTemplate] = useState('');
  const [nudged, setNudged] = useState<string | null>(null);

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const code = (id: string) => members.data?.items.find((m) => m.id === id)?.code ?? '';

  const unreachable = useQuery({
    queryKey: ['notifications-unreachable'],
    queryFn: () => api<Unreachable[]>('/notifications/admin/unreachable'),
  });

  const log = useInfiniteQuery({
    queryKey: ['notifications-admin', template],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '30' });
      if (template) qs.set('template', template);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page<AdminNotification> & { next_cursor: string | null }>(`/notifications/admin?${qs}`);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const nudge = useMutation({
    mutationFn: (memberId: string) =>
      api('/notifications/nudge', { method: 'POST', body: { member_id: memberId, template: 'due_reminder' } }),
    onSuccess: (_d, memberId) => {
      setNudged(memberId);
      void qc.invalidateQueries({ queryKey: ['notifications-admin'] });
    },
  });

  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('adminNotifications.title')}</h1>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 font-semibold">{t('adminNotifications.unreachable')}</h2>
        <p className="mb-3 text-sm text-muted">{t('adminNotifications.unreachableHint')}</p>
        {unreachable.error ? (
          <LoadError error={unreachable.error} onRetry={() => void unreachable.refetch()} />
        ) : !unreachable.data ? (
          <ListSkeleton rows={3} />
        ) : unreachable.data.length === 0 ? (
          <Empty text={t('adminNotifications.allReachable')} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {unreachable.data.map((u) => (
              <li key={u.member_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-medium">{u.code} · {u.full_name}</span>
                  <span className="ml-2 text-muted">{t(`adminNotifications.reason.${u.reason}`)}</span>
                </span>
                {isCashier && (
                  <button
                    type="button"
                    disabled={nudge.isPending}
                    onClick={() => nudge.mutate(u.member_id)}
                    className="h-9 rounded-md border border-border px-3 text-xs hover:bg-hover disabled:opacity-50"
                  >
                    {nudged === u.member_id && nudge.isSuccess ? t('adminNotifications.nudged') : t('adminNotifications.nudge')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {nudge.error && <div className="mt-3"><LoadError error={nudge.error} /></div>}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('adminNotifications.log')}</h2>
          <label className="text-sm text-muted">
            {t('adminNotifications.template')}
            <select className="ml-2 h-11 rounded-md border border-input bg-background px-2" value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">{t('adminNotifications.allTemplates')}</option>
              {TEMPLATES.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
        {log.error ? (
          <LoadError error={log.error} onRetry={() => void log.refetch()} />
        ) : !log.data ? (
          <ListSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <Empty text={t('common.noData')} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead className="text-muted">
                  <tr>
                    <th className="p-2 text-left">{t('adminNotifications.when')}</th>
                    <th className="p-2 text-left">{t('adminNotifications.member')}</th>
                    <th className="p-2 text-left">{t('adminNotifications.template')}</th>
                    <th className="p-2 text-left">{t('adminNotifications.channel')}</th>
                    <th className="p-2 text-left">{t('common.status')}</th>
                    <th className="p-2 text-left">{t('adminNotifications.opened')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((n) => (
                    <tr key={n.id}>
                      <td className="p-2 whitespace-nowrap">{fmtInstant(n.scheduled_for)}</td>
                      <td className="p-2">{code(n.member_id)}</td>
                      <td className="p-2">{n.template}</td>
                      <td className="p-2">{n.channel}</td>
                      <td className="p-2" title={n.error ?? undefined}>{t(`adminNotifications.status.${n.status}`)}</td>
                      <td className="p-2">{n.opened_at ? fmtInstant(n.opened_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {log.hasNextPage && (
              <button type="button" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} className="mt-3 h-11 w-full rounded-md border border-border">
                {t('common.loadMore')}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
