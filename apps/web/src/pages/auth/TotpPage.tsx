import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthShell, FieldError } from '../../components/AuthShell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';

/**
 * Cashier and auditor: enrol an authenticator app, then enter its code. The same screen serves the
 * 12 h step-up before privileged actions.
 */
export function TotpPage() {
  const { t } = useTranslation();
  const { me, refreshMe } = useAuth();
  const navigate = useNavigate();
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const enrolling = !!me && !me.totp_enabled;

  return (
    <AuthShell>
      <h1 className="text-[1.375rem] font-semibold leading-snug">{t('totp.title')}</h1>
      {enrolling && !secret && (
        <>
          <p className="text-[0.8125rem] leading-normal text-muted">{t('totp.enrolHint')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => setSecret((await api<{ secret: string }>('/auth/totp/enroll', { method: 'POST' })).secret))}
            className="h-14 rounded-2xl bg-primary text-[1.0625rem] font-bold text-primary-foreground disabled:opacity-50"
          >
            {t('totp.startEnrol')}
          </button>
        </>
      )}
      {secret && (
        <div className="rounded-2xl border border-border bg-background p-4">
          <p className="text-[0.8125rem] text-muted">{t('totp.secretHint')}</p>
          <p className="mt-2 select-all break-all text-center font-mono text-lg tracking-wider">{secret}</p>
        </div>
      )}
      {(secret || (me && me.totp_enabled)) && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/auth/totp/verify', { method: 'POST', body: { code } });
              await refreshMe();
              void navigate('/', { replace: true });
            });
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={t('totp.code')}
            placeholder="••••••"
            className="field field-lg text-center text-2xl tracking-[0.4em]"
          />
          <FieldError message={error?.message ?? null} requestId={error?.requestId} />
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="h-14 rounded-2xl bg-primary text-[1.0625rem] font-bold text-primary-foreground disabled:opacity-50"
          >
            {t('totp.verify')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
