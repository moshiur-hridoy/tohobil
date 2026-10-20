import { useTranslation } from 'react-i18next';

export function VotesPage() {
  const { t } = useTranslation();

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold">{t('votes.title')}</h2>
      <p className="text-muted">{t('common.noData')}</p>
    </div>
  );
}
