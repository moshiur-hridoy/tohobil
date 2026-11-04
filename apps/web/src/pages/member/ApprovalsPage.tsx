import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';
import { ApprovalsTab } from '../admin/payments/ApprovalsTab';

/**
 * The auditor's approvals inside the member app, so value updates and reversals can be decided from a
 * phone without opening the admin pages. Same list and same confirm sheet as Payments → Approvals.
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('paymentsPage.approvals')} subtitle={t('home.approvalsPageHint')} back="/home" />
      <div className="px-4 pb-6 pt-1">
        <ApprovalsTab />
      </div>
    </div>
  );
}
