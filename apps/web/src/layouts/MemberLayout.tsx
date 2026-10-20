import { Outlet, NavLink, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

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

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col">
      {/* Header: title on the left, avatar menu top right (spec 8) */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <h1 className="text-lg font-semibold text-foreground">{t('app.name')}</h1>
        <Link
          to="/menu"
          aria-label={t('nav.menu')}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-primary"
        >
          <span aria-hidden="true">👤</span>
        </Link>
      </header>

      <main className="flex-1 pb-24">
        <Outlet />
      </main>

      {/* Bottom tab bar. The padding keeps it clear of the iPhone home indicator (viewport-fit=cover). */}
      <nav className="fixed bottom-0 left-0 right-0 mx-auto max-w-lg border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">
        <div className="flex min-h-16 items-stretch justify-around">
          {TABS.map(({ to, labelKey, icon }) => (
            <TabItem key={to} to={to} label={t(labelKey)} icon={icon} />
          ))}
        </div>
      </nav>
    </div>
  );
}

function TabItem({ to, label, icon }: { to: string; label: string; icon: string }) {
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
            className={`grid h-[30px] w-[52px] place-items-center rounded-[15px] ${
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
          </span>
          <span className="max-w-full break-words text-center leading-tight">{label}</span>
        </>
      )}
    </NavLink>
  );
}
