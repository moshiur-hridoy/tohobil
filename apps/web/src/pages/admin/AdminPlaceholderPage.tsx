import { useTranslation } from 'react-i18next';

/** Stand-in for cashier screens that arrive in later phases, so sidebar links never dead-end. */
export function AdminPlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <h1 className="text-3xl font-bold tracking-tight">{t(titleKey)}</h1>
      <p className="text-muted">{t('common.noData')}</p>
    </div>
  );
}
