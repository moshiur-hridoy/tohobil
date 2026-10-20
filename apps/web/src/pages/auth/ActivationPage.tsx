import { useTranslation } from 'react-i18next';

export function ActivationPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <h1 className="mb-6 text-center text-xl font-semibold">{t('app.name')}</h1>
        <p className="mb-4 text-center text-muted">{t('auth.activateHint')}</p>
        <input
          type="text"
          aria-label={t('auth.activateCode')}
          placeholder={t('auth.activateCode')}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full rounded-md border border-input bg-background px-4 py-3 text-center text-lg uppercase tracking-widest"
          maxLength={16}
        />
        <button
          type="button"
          className="mt-4 w-full rounded-md bg-primary py-3 font-medium text-primary-foreground"
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  );
}
