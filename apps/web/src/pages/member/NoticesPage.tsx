import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';

type NoticeKind = 'final_notice' | 'fine' | 'payment_received' | 'meeting' | 'zakat_info';

interface InboxItem {
  id: string;
  template: string;
  payload: { _body?: string; [k: string]: unknown };
  scheduled_for: string;
  opened_at: string | null;
}

const KIND_BY_TEMPLATE: Record<string, NoticeKind> = {
  final_notice: 'final_notice',
  fine_notice: 'fine',
  payment_confirmed: 'payment_received',
  payment_submitted_ack: 'payment_received',
  meeting_reminder: 'meeting',
};

const TAG_KEY: Record<NoticeKind, string> = {
  final_notice: 'notices.tags.finalNotice',
  fine: 'notices.tags.fine',
  payment_received: 'notices.tags.paymentReceived',
  meeting: 'notices.tags.meeting',
  zakat_info: 'notices.tags.zakatInfo',
};

function kindMeta(kind: NoticeKind): { icon: JSX.Element; borderClass: string; chipClass: string } {
  switch (kind) {
    case 'final_notice':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-bad-bg text-bad',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l10 18H2z" />
            <path d="M12 10v5" />
            <path d="M12 18h.01" />
          </svg>
        ),
      };
    case 'fine':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-warn-bg text-warn',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M3 10h18" />
          </svg>
        ),
      };
    case 'payment_received':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-ok-bg text-ok',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" />
            <path d="M8 12l3 3 5-5" />
          </svg>
        ),
      };
    case 'meeting':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-blue-bg text-blue',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6h16v14H4z" />
            <path d="M4 10h16" />
            <path d="M9 3v4" />
            <path d="M15 3v4" />
          </svg>
        ),
      };
    case 'zakat_info':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-soft text-foreground',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v4h4" />
            <path d="M9 13h6" />
            <path d="M9 17h6" />
          </svg>
        ),
      };
  }
}

export function NoticesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');

  const inbox = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: InboxItem[] }>('/notifications?channel=push&limit=50'),
  });
  const open = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/open`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const all = inbox.data?.items ?? [];
  const unreadCount = useMemo(() => all.filter((n) => !n.opened_at).length, [all]);
  const visible = useMemo(() => (filter === 'unread' ? all.filter((n) => !n.opened_at) : all), [filter, all]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/home"
          aria-label={t('common.back', { defaultValue: 'ফিরে যান' })}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="flex-1 pl-1">
          <div className="text-[1.1875rem] font-bold leading-tight">{t('notices.title', { defaultValue: 'নোটিস' })}</div>
          <div className="text-[0.8125rem] text-muted">{t('notices.subtitle', { defaultValue: 'সব বার্তা এখানে থাকে' })}</div>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {/* Unread / All segments */}
        <div className="flex rounded-2xl border border-border bg-card p-1" role="tablist" aria-label={t('notices.filterLabel', { defaultValue: 'নোটিস ফিল্টার' })}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unread'}
            onClick={() => setFilter('unread')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2 text-sm font-bold transition-colors ${
              filter === 'unread' ? 'bg-primary-soft text-primary' : 'text-muted'
            }`}
          >
            {t('notices.unreadTab', { defaultValue: 'অপঠিত' })}
            {unreadCount > 0 && (
              <span className="grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-bad px-1.5 text-[0.6875rem] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            onClick={() => setFilter('all')}
            className={`flex-1 rounded-xl py-2 text-sm font-bold transition-colors ${
              filter === 'all' ? 'bg-primary-soft text-primary' : 'text-muted'
            }`}
          >
            {t('notices.allTab', { defaultValue: 'সব' })}
          </button>
        </div>

        {inbox.error ? (
          <LoadError error={inbox.error} onRetry={() => void inbox.refetch()} />
        ) : !inbox.data ? (
          <ListSkeleton rows={4} />
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-muted">{t('common.noData')}</p>
        ) : (
          visible.map((item) => (
            <NoticeCard key={item.id} item={item} onOpen={() => !item.opened_at && open.mutate(item.id)} />
          ))
        )}
      </main>
    </div>
  );
}

function NoticeCard({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const { t } = useTranslation();
  const kind = KIND_BY_TEMPLATE[item.template] ?? 'zakat_info';
  const meta = kindMeta(kind);
  const known = item.template in KIND_BY_TEMPLATE;

  return (
    <article
      onClick={onOpen}
      className={`rounded-[18px] border bg-card p-4 shadow-sm ${meta.borderClass} ${item.opened_at ? '' : 'ring-1 ring-primary'}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`grid h-9 w-9 flex-none place-items-center rounded-[11px] ${meta.chipClass}`}>{meta.icon}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.chipClass}`}>
          {known ? t(TAG_KEY[kind]) : t('notices.tags.general')}
        </span>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-foreground">{item.payload._body ?? ''}</p>
    </article>
  );
}
