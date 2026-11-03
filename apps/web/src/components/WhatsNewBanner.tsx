import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { APP_VERSION, RELEASES } from '../lib/changelog';
import { localDigits } from '../lib/format';

const KEY = 'barakah.seenVersion';

function seenVersion(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Remember that this device has seen what is new in this version. */
export function markVersionSeen(): void {
  try {
    localStorage.setItem(KEY, APP_VERSION);
  } catch {
    // private window or blocked storage: the banner simply shows again next time
  }
}

/**
 * Once per version, after an update (or the first time ever), a small card says the app was updated
 * and links to "কী নতুন". Closing it or opening the page counts as seen on this device.
 */
export function WhatsNewBanner() {
  const { t } = useTranslation();
  const { status } = useAuth();
  const { pathname } = useLocation();
  const [seen, setSeen] = useState(seenVersion);
  if (status !== 'authenticated' || seen === APP_VERSION || pathname === '/menu/whats-new') return null;
  if (!RELEASES.some((r) => r.version === APP_VERSION)) return null;
  const close = () => {
    markVersionSeen();
    setSeen(APP_VERSION);
  };
  return (
    <div role="status" className="fixed inset-x-4 top-[calc(0.75rem+env(safe-area-inset-top))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-lg">
      <span className="min-w-0 flex-1 text-sm">{t('whatsNew.updated', { version: localDigits(APP_VERSION) })}</span>
      <Link to="/menu/whats-new" onClick={close} className="shrink-0 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
        {t('whatsNew.see')}
      </Link>
      <button type="button" onClick={close} aria-label={t('common.close')} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:bg-hover">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}
