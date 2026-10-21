import { useTranslation } from 'react-i18next';
import { AdminHeader, AdminPage, Card, EmptyCard } from '../../components/admin';

/** Stand-in for cashier screens that arrive in later phases, so sidebar links never dead-end. */
export function AdminPlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();

  return (
    <AdminPage>
      <AdminHeader title={t(titleKey)} />
      <Card className="p-5">
        <EmptyCard text={t('common.noData')} />
      </Card>
    </AdminPage>
  );
}
