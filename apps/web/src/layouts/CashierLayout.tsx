import { Outlet, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';

/** [route, i18n key]: one source for the desktop sidebar and the stacked mobile nav. */
export const ADMIN_NAV = [
  ['/admin', 'admin.nav.dashboard'],
  ['/admin/matrix', 'admin.nav.matrix'],
  ['/admin/payments', 'admin.nav.payments'],
  ['/admin/ledger', 'admin.nav.ledger'],
  ['/admin/members', 'admin.nav.members'],
  ['/admin/proposals', 'admin.nav.proposals'],
  ['/admin/assets', 'admin.nav.assets'],
  ['/admin/rent', 'admin.nav.rent'],
  ['/admin/notifications', 'admin.nav.notifications'],
  ['/admin/reconcile', 'admin.nav.reconcile'],
  ['/admin/reports', 'admin.nav.reports'],
  ['/admin/rules', 'admin.nav.rules'],
  ['/admin/system', 'admin.nav.system'],
] as const;

type AdminRoute = (typeof ADMIN_NAV)[number][0];

const ADMIN_NAV_META: Record<AdminRoute, { icon: string }> = {
  '/admin': { icon: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' },
  '/admin/matrix': { icon: 'M4 5h16v14H4zM4 10h16M10 5v14' },
  '/admin/payments': { icon: 'M3 7h18v12H3zM3 11h18M16 15h2' },
  '/admin/ledger': { icon: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11' },
  '/admin/members': { icon: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 5a3.5 3.5 0 0 1 0 6.5M18 14.5c2 .7 3.5 2.4 3.5 5.5' },
  '/admin/proposals': { icon: 'M4 4h16v16H4zM9 12l2 2 4-4' },
  '/admin/assets': { icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5' },
  '/admin/rent': { icon: 'M3 21h18M5 21V10l7-4 7 4v11M9 21v-6h6v6' },
  '/admin/notifications': { icon: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4' },
  '/admin/reconcile': { icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4' },
  '/admin/reports': { icon: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6' },
  '/admin/rules': { icon: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4' },
  '/admin/system': { icon: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01' },
};

const NAV_GROUPS: { titleKey: string; routes: AdminRoute[] }[] = [
  {
    titleKey: 'admin.nav.group.overview',
    routes: ['/admin', '/admin/matrix'],
  },
  {
    titleKey: 'admin.nav.group.accounts',
    routes: ['/admin/payments', '/admin/ledger', '/admin/assets', '/admin/rent', '/admin/reconcile'],
  },
  {
    titleKey: 'admin.nav.group.membersAndDecisions',
    routes: ['/admin/members', '/admin/proposals', '/admin/notifications', '/admin/rules', '/admin/reports'],
  },
  {
    titleKey: 'admin.nav.group.administration',
    routes: ['/admin/system'],
  },
];

function labelForRoute(to: AdminRoute): string {
  const found = ADMIN_NAV.find(([route]) => route === to);
  return found ? found[1] : '';
}

export function CashierLayout() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Sidebar (desktop, 1024px and above) */}
      <aside className="hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3 px-1">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
              <AppLogo className="h-5 w-5" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">{t('app.shortName')}</h1>
          </div>
          <ProfileCard />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.titleKey}>
              <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-muted">
                {t(group.titleKey)}
              </div>
              {group.routes.map((to) => (
                <SidebarLink
                  key={to}
                  to={to}
                  label={t(labelForRoute(to))}
                  icon={ADMIN_NAV_META[to].icon}
                />
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Stacked mobile layout: the cashier must be able to confirm a payment from a phone */}
      <nav className="flex gap-1 overflow-x-auto border-b border-border bg-card p-2 lg:hidden">
        {ADMIN_NAV.map(([to, key]) => (
          <SidebarLink
            key={to}
            to={to}
            label={t(key)}
            icon={ADMIN_NAV_META[to].icon}
            compact
          />
        ))}
      </nav>

      <main className="flex-1 p-4 lg:p-6">
        <Outlet />
      </main>
    </div>
  );
}

function AppLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />
    </svg>
  );
}

function ProfileCard() {
  const { t } = useTranslation();
  const { me } = useAuth();

  const initials =
    me?.full_name
      ?.split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() ?? '—';

  const role = me?.roles.includes('cashier')
    ? t('roles.cashier')
    : me?.roles.includes('auditor')
      ? t('roles.auditor')
      : t('roles.member');

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-background p-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-full bg-primary-soft text-sm font-bold text-primary">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{me?.full_name ?? t('common.loading')}</div>
        <div className="text-xs text-muted">{role}</div>
      </div>
    </div>
  );
}

function SidebarLink({
  to,
  label,
  icon,
  compact = false,
}: {
  to: AdminRoute;
  label: string;
  icon: string;
  compact?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/admin'}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
          compact ? 'whitespace-nowrap' : ''
        } ${
          isActive
            ? 'bg-primary-soft font-bold text-primary'
            : 'text-foreground hover:bg-hover'
        }`
      }
    >
      <svg
        width="20"
        height="20"
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
      <span className={compact ? '' : 'flex-1'}>{label}</span>
    </NavLink>
  );
}
