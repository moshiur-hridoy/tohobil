import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { daysBetween, dhakaTime, fmtClock, fmtDate, todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { toDhakaDate } from '@barakah/shared';

type NoticeKind = 'final_notice' | 'fine' | 'payment_received' | 'meeting' | 'zakat_info';

interface InboxItem {
  id: string;
  template: string;
  payload: { _body?: string; [k: string]: unknown };
  scheduled_for: string;
  sent_at: string | null;
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
  const navigate = useNavigate();
  const location = useLocation();

  const inbox = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: InboxItem[] }>('/notifications?channel=push&limit=50'),
  });
  // Reading a notice only clears its dot: it stays where it is in the list (newest first), so nothing
  // jumps away under the member's finger. The cache is updated at once, then refreshed from the server.
  const markRead = (ids: string[] | 'all') =>
    qc.setQueryData<{ items: InboxItem[] }>(['notifications'], (old) =>
      old && { ...old, items: old.items.map((n) => (!n.opened_at && (ids === 'all' || ids.includes(n.id)) ? { ...n, opened_at: new Date().toISOString() } : n)) },
    );
  const open = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/open`, { method: 'POST' }),
    onMutate: (id) => markRead([id]),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const openAll = useMutation({
    mutationFn: () => api('/notifications/open-all', { method: 'POST' }),
    onMutate: () => markRead('all'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const all = inbox.data?.items ?? [];
  const unreadCount = useMemo(() => all.filter((n) => !n.opened_at).length, [all]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/home"
          onClick={(e) => {
            // Opened from both the home bell and the menu: go back to whichever it was.
            // 'default' is the first page of the session (e.g. opened from a push), so fall back to /home.
            if (location.key !== 'default') {
              e.preventDefault();
              void navigate(-1);
            }
          }}
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
        {unreadCount > 0 && (
          <div className="flex items-center justify-between gap-3 px-1">
            <span className="text-sm font-semibold text-primary">{t('notices.newCount', { n: formatCount(unreadCount) })}</span>
            <button
              type="button"
              disabled={openAll.isPending}
              onClick={() => openAll.mutate()}
              className="h-9 rounded-xl border border-border bg-card px-3 text-sm font-semibold"
            >
              {t('notices.markAllRead')}
            </button>
          </div>
        )}

        {inbox.error ? (
          <LoadError error={inbox.error} onRetry={() => void inbox.refetch()} />
        ) : !inbox.data ? (
          <ListSkeleton rows={4} />
        ) : all.length === 0 ? (
          <p className="py-8 text-center text-muted">{t('common.noData')}</p>
        ) : (
          all.map((item) => (
            <NoticeCard key={item.id} item={item} onOpen={() => !item.opened_at && open.mutate(item.id)} />
          ))
        )}
      </main>
    </div>
  );
}

/** "আজ, সকাল ১০:১২" / "গতকাল, রাত ৯:৩০" / "২ নভেম্বর ২০২৬" for when the notice came. */
function whenText(t: ReturnType<typeof useTranslation>['t'], iso: string): string {
  const day = toDhakaDate(new Date(iso));
  const ago = daysBetween(day, todayDhaka());
  const clock = fmtClock(t, dhakaTime(iso));
  if (ago <= 0) return `${t('relDay.today')}, ${clock}`;
  if (ago === 1) return `${t('relDay.yesterday')}, ${clock}`;
  return fmtDate(day);
}

function NoticeCard({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const { t } = useTranslation();
  const kind = KIND_BY_TEMPLATE[item.template] ?? 'zakat_info';
  const meta = kindMeta(kind);
  const known = item.template in KIND_BY_TEMPLATE;
  const unread = !item.opened_at;

  return (
    <article
      onClick={onOpen}
      className={`rounded-[18px] border bg-card p-4 shadow-sm transition-opacity ${meta.borderClass} ${unread ? 'ring-1 ring-primary' : 'opacity-75'}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`grid h-9 w-9 flex-none place-items-center rounded-[11px] ${meta.chipClass}`}>{meta.icon}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.chipClass}`}>
          {known ? t(TAG_KEY[kind]) : t('notices.tags.general')}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
          {whenText(t, item.sent_at ?? item.scheduled_for)}
          {unread && <span aria-label={t('notices.new')} className="h-2.5 w-2.5 rounded-full bg-primary" />}
        </span>
      </div>
      <p className={`mt-2.5 text-sm leading-relaxed text-foreground ${unread ? 'font-medium' : ''}`}>{item.payload._body ?? ''}</p>
    </article>
  );
}
