import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, BTN_SECONDARY, BTN_SM, Card, CardHead, EmptyCard, ICONS, MemberBadge, SplitLayout } from '../../components/admin';
import { formatCount } from '../../lib/format';
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

  const STATUS_TONE: Record<AdminNotification['status'], string> = {
    queued: 'bg-soft text-ink2',
    sent: 'bg-ok-bg text-ok',
    failed: 'bg-bad-bg text-bad',
    skipped: 'bg-warn-bg text-warn',
  };

  return (
    <AdminPage>
      <AdminHeader title={t('adminNotifications.title')} subtitle={t('adminUi.sub.notifications')} />

      <SplitLayout
        main={
          <Card className="px-5 pb-3 pt-5 sm:px-6">
            <CardHead
              icon={ICONS.bell}
              title={t('adminNotifications.log')}
              action={
                <select aria-label={t('adminNotifications.template')} className="field" value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="">{t('adminNotifications.template')}: {t('adminNotifications.allTemplates')}</option>
                  {TEMPLATES.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              }
            />
            {log.error ? (
              <LoadError error={log.error} onRetry={() => void log.refetch()} />
            ) : !log.data ? (
              <ListSkeleton rows={5} />
            ) : rows.length === 0 ? (
              <EmptyCard text={t('common.noData')} icon={ICONS.bell} />
            ) : (
              <>
                <div className="-mx-2 overflow-x-auto">
                  <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs font-semibold text-muted">
                        <th className="border-b border-border px-2 py-2.5">{t('adminNotifications.when')}</th>
                        <th className="border-b border-border px-2 py-2.5">{t('adminNotifications.member')}</th>
                        <th className="border-b border-border px-2 py-2.5">{t('adminNotifications.template')}</th>
                        <th className="border-b border-border px-2 py-2.5">{t('adminNotifications.channel')}</th>
                        <th className="border-b border-border px-2 py-2.5">{t('common.status')}</th>
                        <th className="border-b border-border px-2 py-2.5">{t('adminNotifications.opened')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((n) => (
                        <tr key={n.id} className="transition-colors hover:bg-hover">
                          <td className="whitespace-nowrap border-b border-border px-2 py-2.5 text-ink2">{fmtInstant(n.scheduled_for)}</td>
                          <td className="border-b border-border px-2 py-2.5 font-semibold">{code(n.member_id)}</td>
                          <td className="border-b border-border px-2 py-2.5 font-mono text-xs">{n.template}</td>
                          <td className="border-b border-border px-2 py-2.5 uppercase text-ink2">{n.channel}</td>
                          <td className="border-b border-border px-2 py-2.5" title={n.error ?? undefined}>
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[n.status]}`}>{t(`adminNotifications.status.${n.status}`)}</span>
                          </td>
                          <td className="whitespace-nowrap border-b border-border px-2 py-2.5 text-ink2">{n.opened_at ? fmtInstant(n.opened_at) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {log.hasNextPage && (
                  <button type="button" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} className={`${BTN_SECONDARY} mb-2 mt-3 w-full`}>
                    {t('common.loadMore')}
                  </button>
                )}
              </>
            )}
          </Card>
        }
        side={
          <Card className="px-5 pb-3 pt-5">
            <CardHead
              icon={ICONS.alert}
              tone="bg-warn-bg text-warn"
              title={t('adminNotifications.unreachable')}
              sub={t('adminNotifications.unreachableHint')}
              action={unreachable.data && unreachable.data.length > 0 ? (
                <span className="rounded-full bg-warn-bg px-2.5 py-0.5 text-xs font-bold text-warn tabular-nums">{formatCount(unreachable.data.length)}</span>
              ) : undefined}
            />
            {unreachable.error ? (
              <LoadError error={unreachable.error} onRetry={() => void unreachable.refetch()} />
            ) : !unreachable.data ? (
              <ListSkeleton rows={3} />
            ) : unreachable.data.length === 0 ? (
              <EmptyCard text={t('adminNotifications.allReachable')} />
            ) : (
              <ul>
                {unreachable.data.map((u) => (
                  <li key={u.member_id} className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0">
                    <MemberBadge code={u.code} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{u.full_name}</p>
                      <p className="truncate text-xs text-muted">{t(`adminNotifications.reason.${u.reason}`)}</p>
                    </div>
                    {isCashier && (
                      <button type="button" disabled={nudge.isPending} onClick={() => nudge.mutate(u.member_id)} className={BTN_SM}>
                        {nudged === u.member_id && nudge.isSuccess ? `✓ ${t('adminNotifications.nudged')}` : t('adminNotifications.nudge')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {nudge.error && <div className="mt-3"><LoadError error={nudge.error} /></div>}
          </Card>
        }
      />
    </AdminPage>
  );
}
