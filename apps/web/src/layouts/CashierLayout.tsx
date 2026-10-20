import { Outlet, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

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

export function CashierLayout() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Sidebar (desktop, 1024px and above) */}
      <aside className="hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="border-b border-border p-4">
          <h1 className="text-lg font-semibold">{t('app.name')}</h1>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {ADMIN_NAV.map(([to, key]) => (
            <SidebarLink key={to} to={to} label={t(key)} />
          ))}
        </nav>
      </aside>

      {/* Stacked mobile layout: the cashier must be able to confirm a payment from a phone */}
      <nav className="flex gap-1 overflow-x-auto border-b border-border bg-card p-2 lg:hidden">
        {ADMIN_NAV.map(([to, key]) => (
          <SidebarLink key={to} to={to} label={t(key)} compact />
        ))}
      </nav>

      <main className="flex-1 p-4 lg:p-6">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarLink({
  to,
  label,
  compact = false,
}: {
  to: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/admin'}
      className={({ isActive }) =>
        `rounded-md px-3 py-2 ${compact ? 'whitespace-nowrap' : 'block'} ${
          isActive ? 'bg-primary-soft font-medium text-primary' : 'text-foreground hover:bg-hover'
        }`
      }
    >
      {label}
    </NavLink>
  );
}
