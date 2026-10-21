import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage } from '../../components/admin';
import { api } from '../../lib/api';
import type { SettlementView } from '../../lib/types';
import { SettlementCard } from '../member/SettlementPage';

/** Every member's settlement, with the cashier's "pay out" button on each unpaid instalment. */
export function AdminSettlementsPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['settlements'], queryFn: () => api<{ items: SettlementView[] }>('/settlements') });
  return (
    <AdminPage>
      <AdminHeader title={t('admin.nav.settlements')} subtitle={t('settlement.adminSubtitle')} />
      {q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <ListSkeleton rows={3} />
      ) : q.data.items.length === 0 ? (
        <Empty text={t('settlement.empty')} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {q.data.items.map((s) => <SettlementCard key={s.id} s={s} />)}
        </div>
      )}
    </AdminPage>
  );
}
