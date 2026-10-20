import { useTranslation } from 'react-i18next';

export function LoginPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <h1 className="mb-6 text-center text-xl font-semibold">{t('app.name')}</h1>
        <p className="mb-4 text-center text-muted">{t('auth.pinHint')}</p>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          aria-label={t('auth.pinHint')}
          placeholder={t('auth.pinPlaceholder')}
          className="w-full rounded-md border border-input bg-background px-4 py-3 text-center text-2xl tracking-widest"
          maxLength={6}
        />
        <button
          type="button"
          className="mt-4 w-full rounded-md bg-primary py-3 font-medium text-primary-foreground"
        >
          {t('common.submit')}
        </button>
      </div>
    </div>
  );
}
