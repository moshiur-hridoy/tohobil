import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <p className="text-lg">{t('errors.pageNotFound')}</p>
      <Link
        to="/home"
        className="rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground"
      >
        {t('nav.home')}
      </Link>
    </div>
  );
}
