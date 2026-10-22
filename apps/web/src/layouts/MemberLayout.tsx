import { Outlet, NavLink, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSyncPush } from '../lib/push';
import type { ProposalSummary } from '../lib/types';
import { Avatar, useMyPhoto } from '../components/MemberPhoto';

const TABS = [
  {
    to: '/home',
    labelKey: 'nav.home',
    icon: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  },
  {
    to: '/pay',
    labelKey: 'nav.pay',
    icon: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 10h18 M16 14.5h2',
  },
  {
    to: '/votes',
    labelKey: 'nav.votes',
    icon: 'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z M9 12l2 2 4-4',
  },
  {
    to: '/assets',
    labelKey: 'nav.assets',
    icon: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  },
  {
    to: '/menu',
    labelKey: 'nav.menu',
    icon: 'M4 7h16 M4 12h16 M4 17h16',
  },
] as const;

export function MemberLayout() {
  const { t } = useTranslation();
  const { me } = useAuth();
  useSyncPush(!!me);
  // Same query as the Votes page and Home, so it shares their cache; the tab shows how many votes are open.
  const proposals = useQuery({
    queryKey: ['proposals', 'member'],
    queryFn: () => api<{ items: ProposalSummary[]; next_cursor: string | null }>('/proposals?limit=200'),
    refetchInterval: 60_000,
  });
  const openVotes = proposals.data?.items.filter((p) => p.status === 'open').length ?? 0;
  const onHome = useLocation().pathname === '/home';
  const initial = me?.full_name?.trim().charAt(0) || '👤';
  const myPhoto = useMyPhoto();

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      {/* Header: greeting on the left, notices bell on the right (design: Member · Home) */}
      {onHome && (
      <header className="flex items-center gap-3 px-4 pb-3 pt-4">
        <Link
          to="/menu"
          aria-label={t('nav.menu')}
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar fileId={myPhoto} fallback={initial} className="h-11 w-11 bg-primary-soft text-lg font-bold text-primary" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="text-[0.8125rem] text-muted">{t('app.greeting')}</div>
          <div className="truncate text-[1.1875rem] font-bold leading-tight">{me?.full_name ?? t('app.name')}</div>
        </div>
        <Link
          to="/menu/notices"
          aria-label={t('notices.title')}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7 M10 20a2 2 0 0 0 4 0" />
          </svg>
        </Link>
      </header>
      )}

      <main className="min-w-0 flex-1 pb-24">
        <Outlet />
      </main>

      {/* Bottom tab bar. The padding keeps it clear of the iPhone home indicator (viewport-fit=cover). */}
      <nav className="fixed bottom-0 left-0 right-0 mx-auto max-w-lg border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">
        <div className="flex min-h-16 items-stretch justify-around">
          {TABS.map(({ to, labelKey, icon }) => (
            <TabItem key={to} to={to} label={t(labelKey)} icon={icon} badge={to === '/votes' ? openVotes : 0} />
          ))}
        </div>
      </nav>
    </div>
  );
}

function TabItem({ to, label, icon, badge = 0 }: { to: string; label: string; icon: string; badge?: number }) {
  const { t } = useTranslation();
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-1 text-xs ${
          isActive ? 'font-bold text-primary' : 'text-muted'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`relative grid h-[30px] w-[52px] place-items-center rounded-[15px] ${
              isActive ? 'bg-primary-soft text-primary' : 'text-muted'
            }`}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={icon} />
            </svg>
            {badge > 0 && (
              <span
                role="status"
                aria-label={t('votes.openCount', { count: badge })}
                className="absolute -right-0.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-bad px-1 text-[0.6875rem] font-bold leading-none text-on-bad"
              >
                {badge}
              </span>
            )}
          </span>
          <span className="max-w-full break-words text-center leading-tight">{label}</span>
        </>
      )}
    </NavLink>
  );
}
