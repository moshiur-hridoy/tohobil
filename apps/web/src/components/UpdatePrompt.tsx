import { useRegisterSW } from 'virtual:pwa-register/react';
import { useTranslation } from 'react-i18next';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * "Update available" toast with a reload button (spec 8, PWA). The service worker is registered in
 * `prompt` mode: a new version waits until the user taps reload, then takes over and the page
 * reloads, so users never keep running a stale app.
 */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Long-lived installed PWAs would otherwise only look for updates on navigation.
      if (registration) setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS);
    },
  });

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-24 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 shadow-lg"
    >
      <span>{t('common.updateAvailable')}</span>
      <button
        type="button"
        onClick={() => void updateServiceWorker(true)}
        className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
      >
        {t('common.reload')}
      </button>
    </div>
  );
}
