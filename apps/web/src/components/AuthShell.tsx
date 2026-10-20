import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Brand header + centred card shared by the activation, PIN and TOTP screens (design: Login). */
export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-background px-5 pb-7 pt-12">
      <div className="flex items-center gap-3">
        <div className="grid h-[50px] w-[50px] place-items-center rounded-[15px] bg-primary text-primary-foreground">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l9 5-9 5-9-5z M3 13l9 5 9-5" />
          </svg>
        </div>
        <div>
          <div className="text-2xl font-bold leading-tight">{t('app.name')}</div>
          <div className="text-[13px] text-muted">{t('auth.tagline')}</div>
        </div>
      </div>
      <section className="flex flex-col gap-[18px] rounded-3xl border border-border bg-card p-5">
        {children}
      </section>
      {footer && (
        <div className="mt-auto rounded-[18px] border border-border bg-card px-4 py-3.5 text-[13px] leading-[1.7] text-muted">
          {footer}
        </div>
      )}
    </div>
  );
}

export function FieldError({ message, requestId }: { message: string | null; requestId?: string | undefined }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-bad">
      {message}
      {requestId && (
        <span className="mt-1 block text-xs text-muted">
          {t('errors.requestId')}: <span className="select-all">{requestId}</span>
        </span>
      )}
    </p>
  );
}
