import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthShell, FieldError } from '../../components/AuthShell';
import { PinPad } from '../../components/PinPad';
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
        <h1 className="text-[1.375rem] font-semibold leading-snug">{t('auth.signInTitle')}</h1>
        <label className="block text-sm text-muted">
          {t('auth.memberRef')}
          <input
            className="mt-1 h-14 w-full rounded-2xl border border-input bg-background px-4 text-[1.0625rem] uppercase text-foreground"
            value={ref}
            autoCapitalize="characters"
            autoComplete="username"
            placeholder="M01"
            onChange={(e) => setRef(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!valid}
          onClick={() => setChosenRef(ref.trim().toUpperCase())}
          className="h-14 rounded-2xl bg-primary text-[1.0625rem] font-bold text-primary-foreground disabled:opacity-50"
        >
          {t('auth.continue')}
        </button>
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

  return (
    <AuthShell footer={t('auth.pinFooter')}>
      <div>
        <h1 className="text-[1.375rem] font-semibold leading-snug">{t('auth.pinTitle')}</h1>
        <p className="mt-1 text-[0.8125rem] leading-normal text-muted">
          {t('auth.pinHint')} · {activeRef}
        </p>
      </div>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(p) => void submit(p)} disabled={busy} invalid={!!error} />
      <FieldError message={error?.message ?? null} requestId={error?.requestId} />
      {forgot && <p className="text-[0.8125rem] leading-normal text-muted">{t('auth.forgotPinBody')}</p>}
      <div className="flex flex-wrap gap-4">
        <button type="button" className="text-sm text-muted underline" onClick={() => setForgot(true)}>
          {t('auth.forgotPin')}
        </button>
        <button
          type="button"
          className="text-sm text-muted underline"
          onClick={() => {
            auth.forgetDevice();
            setChosenRef(null);
            setRef('');
            setPin('');
            setError(null);
          }}
        >
          {t('auth.notYou')}
        </button>
      </div>
    </AuthShell>
  );
}
