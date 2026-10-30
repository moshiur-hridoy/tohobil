import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';

/** True in the public UI demo build (docs/DEMO.md). */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';

const ROLES = [
  { ref: 'M01', key: 'cashier' },
  { ref: 'M07', key: 'auditor' },
  { ref: 'M02', key: 'member' },
] as const;

/** One tap per demo account on the sign-in screen; the PIN is not checked in the demo. */
export function DemoLogin() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-2xl font-bold leading-snug">{t('demo.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('demo.hint')}</p>
      </div>
      {ROLES.map(({ ref, key }) => (
        <button
          key={ref}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(ref);
            try {
              await auth.login('000000', ref);
              void navigate('/', { replace: true });
            } finally {
              setBusy(null);
            }
          }}
          className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-soft disabled:opacity-60"
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-sm font-bold text-primary">{ref}</span>
          <span className="flex flex-col">
            <span className="font-semibold">{t(`demo.${key}`)}</span>
            <span className="text-[0.8125rem] text-muted">{t(`demo.${key}Hint`)}</span>
          </span>
        </button>
      ))}
      <p className="pt-2 text-center text-[0.8125rem] text-muted">{t('demo.or')}</p>
    </div>
  );
}

/** A small floating badge while signed in to the demo, with the way back to the role picker. */
export function DemoBanner() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  if (auth.status !== 'authenticated') return null;

  return (
    // Phones get only the button, so the badge hides as little of the screen as possible.
    <div className="fixed bottom-24 right-3 z-[60] flex items-center gap-2 rounded-full text-[0.75rem] shadow-lg lg:bottom-4 lg:border lg:border-border lg:bg-card lg:py-1 lg:pl-3 lg:pr-1 lg:text-[0.8125rem]">
      <span className="hidden font-semibold lg:inline">{t('demo.badge')}</span>
      <button
        type="button"
        className="min-h-8 rounded-full bg-primary px-3 font-semibold text-primary-foreground opacity-90 hover:opacity-100 lg:min-h-9"
        onClick={async () => {
          await auth.logout();
          auth.forgetDevice();
          void navigate('/login', { replace: true });
        }}
      >
        {t('demo.switchRole')}
      </button>
    </div>
  );
}
