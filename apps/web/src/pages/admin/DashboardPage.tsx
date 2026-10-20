import { useTranslation } from 'react-i18next';
import { formatCount, formatTaka } from '../../lib/format';

export function AdminDashboard() {
  const { t } = useTranslation();

  // Placeholder figures: Phase 1 replaces these with computed values (dashboard numbers are never typed).
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('admin.dashboard')}</h1>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('admin.netAssets')} value={formatTaka(0n)} />
        <StatCard label={t('admin.collectedThisMonth')} value={formatTaka(0n)} />
        <StatCard label={t('admin.overdueMembers')} value={formatCount(0)} />
        <StatCard label={t('admin.pendingPayments')} value={formatCount(0)} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
