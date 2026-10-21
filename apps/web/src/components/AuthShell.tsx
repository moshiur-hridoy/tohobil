import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './ui';
import { Wordmark } from './Logo';

const TRUST = [
  ['auth.trustLedger', 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4'],
  ['auth.trustOpen', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  ['auth.trustPin', 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2'],
] as const;

/** The L-shaped mark of the app icon, drawn large and faint behind the brand panel. */
const MARK = 'M14.6293 56.7565H58.3018V25.4919H79.3712V71.3015H28.3956L14.6293 56.7565Z';

/**
 * Shared frame of the activation, PIN and TOTP screens: a brand panel (left on wide screens, a header
 * band on phones) and the form card. The brand panel uses the hero tokens, so it is dark in both themes.
 */
export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside className="relative overflow-hidden rounded-b-[32px] bg-hero px-6 pb-16 pt-10 text-on-hero lg:flex lg:min-h-screen lg:flex-col lg:rounded-none lg:px-14 lg:py-12">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(70% 60% at 85% 0%, var(--hero-icon) 0%, transparent 70%)' }} />
        <svg aria-hidden="true" viewBox="10 20 75 56" className="pointer-events-none absolute -bottom-6 -right-6 hidden w-[380px] text-hero-action opacity-[0.07] lg:block">
          <path d={MARK} fill="currentColor" />
        </svg>

        <div className="relative mx-auto flex max-w-md flex-col items-center text-center lg:mx-0 lg:my-auto lg:items-start lg:text-left">
          <Wordmark className="h-auto w-[168px] lg:w-[240px]" />
          <p className="mt-4 text-[0.9375rem] text-on-hero-muted lg:mt-8 lg:text-xl lg:font-semibold lg:text-on-hero">{t('auth.brandTagline')}</p>
          <ul className="mt-10 hidden space-y-5 lg:block">
            {TRUST.map(([key, d]) => (
              <li key={key} className="flex items-center gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-hero-chip text-hero-action">
                  <Icon d={d} />
                </span>
                <span className="text-[0.9375rem] text-on-hero-muted">{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-auto hidden text-xs text-on-hero-muted lg:block">{t('app.name')}</p>
      </aside>

      <main className="relative -mt-8 flex flex-col px-5 pb-10 lg:mt-0 lg:justify-center lg:px-12 lg:py-12">
        <div className="mx-auto flex w-full max-w-[26rem] flex-col gap-5">
          <section className="flex flex-col gap-5 rounded-[28px] border border-border bg-card p-6 shadow-lift sm:p-7">{children}</section>
          {footer && (
            <div className="flex gap-3 rounded-[20px] border border-border bg-card px-4 py-3.5 text-[0.8125rem] leading-[1.7] text-muted">
              <span className="mt-0.5 shrink-0 text-ink2"><Icon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.01" size={18} /></span>
              <div>{footer}</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export function FieldError({ message, requestId }: { message: string | null; requestId?: string | undefined }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <p role="alert" className="flex gap-2 rounded-xl bg-bad-bg px-3 py-2.5 text-sm text-bad">
      <span aria-hidden="true" className="font-bold">!</span>
      <span>
        {message}
        {requestId && (
          <span className="mt-1 block text-xs text-muted">
            {t('errors.requestId')}: <span className="select-all">{requestId}</span>
          </span>
        )}
      </span>
    </p>
  );
}
