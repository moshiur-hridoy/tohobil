import { useTranslation } from 'react-i18next';

export function PayPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">{t('payment.title')}</h2>

      {/* How to pay */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 font-medium">{t('payment.submitPayment')}</h3>
        <p className="text-muted">{t('payment.instructionsPlaceholder')}</p>
      </div>

      {/* Payment history */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 font-medium">{t('payment.history')}</h3>
        <p className="text-muted">{t('common.noData')}</p>
      </div>
    </div>
  );
}
