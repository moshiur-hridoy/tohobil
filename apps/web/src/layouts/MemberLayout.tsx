import { Outlet, NavLink, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

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
        <div className="flex h-16 items-center justify-around">
          <TabItem to="/home" label={t('nav.home')} icon="🏠" />
          <TabItem to="/pay" label={t('nav.pay')} icon="💰" />
          <TabItem to="/votes" label={t('nav.votes')} icon="🗳️" />
          <TabItem to="/assets" label={t('nav.assets')} icon="🏦" />
          <TabItem to="/menu" label={t('nav.menu')} icon="☰" />
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
        `flex min-w-[3.5rem] flex-col items-center gap-0.5 px-2 py-1 text-xs ${
          isActive ? 'font-medium text-primary' : 'text-muted'
        }`
      }
    >
      <span className="text-xl" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
    </NavLink>
  );
}
