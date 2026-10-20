import { useTranslation } from 'react-i18next';

export function MenuPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">{t('nav.menu')}</h2>
      <p className="text-muted">{t('menu.placeholder')}</p>
    </div>
  );
}
