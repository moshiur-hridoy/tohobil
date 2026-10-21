import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthShell, FieldError } from '../../components/AuthShell';
import { PinPad } from '../../components/PinPad';
import { Icon } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';

/** Member ID, then the PIN pad. Works on any device: the PIN is the only credential members hold. */
export function LoginPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [ref, setRef] = useState('');
  const [chosenRef, setChosenRef] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;
  if (auth.status === 'loading') return null;

  const activeRef = chosenRef ?? auth.memberRef;

  if (!activeRef) {
    const valid = /^M\d{2}$/.test(ref.trim().toUpperCase());
    return (
      <AuthShell footer={t('auth.pinFooter')}>
        <div>
          <h1 className="text-2xl font-bold leading-snug">{t('auth.signInTitle')}</h1>
          <p className="mt-1 text-sm text-muted">{t('auth.signInHint')}</p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) setChosenRef(ref.trim().toUpperCase());
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink2">
            {t('auth.memberRef')}
            <span className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted">
                <Icon d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7" />
              </span>
              <input
                className="field field-lg w-full pl-12 font-semibold uppercase tracking-wider"
                value={ref}
                autoFocus
                autoCapitalize="characters"
                autoComplete="username"
                spellCheck={false}
                maxLength={3}
                placeholder="M01"
                onChange={(e) => setRef(e.target.value)}
              />
            </span>
          </label>
          <button
            type="submit"
            disabled={!valid}
            className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-primary text-[1.0625rem] font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {t('auth.continue')}
            <Icon d="M5 12h14M13 6l6 6-6 6" sw={2.2} />
          </button>
        </form>
      </AuthShell>
    );
  }

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await auth.login(value, activeRef);
      void navigate('/', { replace: true });
    } catch (err) {
      const msg = errorMessage(t, err);
      const left = err instanceof ApiError ? err.extra.attempts_left : undefined;
      setError({
        ...msg,
        message: typeof left === 'number' ? `${msg.message} ${t('auth.attemptsLeft', { count: left })}` : msg.message,
      });
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const notYou = () => {
    auth.forgetDevice();
    setChosenRef(null);
    setRef('');
    setPin('');
    setError(null);
  };

  return (
    <AuthShell footer={t('auth.pinFooter')}>
      <div>
        <h1 className="text-2xl font-bold leading-snug">{t('auth.pinTitle')}</h1>
        <p className="mt-1 text-sm text-muted">{t('auth.pinHint')}</p>
      </div>
      {/* who is signing in, with the way out right next to it */}
      <div className="flex items-center gap-3 rounded-2xl bg-soft p-2.5 pr-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-sm font-bold text-primary">{activeRef}</span>
        <span className="flex-1 text-sm font-semibold">{t('auth.signingInAs', { ref: activeRef })}</span>
        <button type="button" className="min-h-11 text-sm font-semibold text-primary hover:underline" onClick={notYou} aria-label={t('auth.notYou')}>
          {t('auth.change')}
        </button>
      </div>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(p) => void submit(p)} disabled={busy} invalid={!!error} />
      <FieldError message={error?.message ?? null} requestId={error?.requestId} />
      {forgot ? (
        <p className="rounded-xl bg-soft px-3 py-2.5 text-[0.8125rem] leading-normal text-ink2">{t('auth.forgotPinBody')}</p>
      ) : (
        <button type="button" className="mx-auto min-h-11 text-sm text-muted underline-offset-4 hover:text-foreground hover:underline" onClick={() => setForgot(true)}>
          {t('auth.forgotPin')}
        </button>
      )}
    </AuthShell>
  );
}
