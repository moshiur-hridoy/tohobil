import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthShell, FieldError } from '../../components/AuthShell';
import { PinPad } from '../../components/PinPad';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';

/** PIN pad on a registered device (spec 19.1), or the "device reset needed" screen. */
export function LoginPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [resetNeeded, setResetNeeded] = useState(false);
  const [busy, setBusy] = useState(false);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;
  if (auth.status === 'loading') return null;
  if (!auth.hasDevice && !resetNeeded) return <Navigate to="/activate" replace />;

  if (resetNeeded) {
    return (
      <AuthShell>
        <h1 className="text-[22px] font-semibold leading-snug">{t('auth.deviceResetTitle')}</h1>
        <p className="text-[13px] leading-normal text-muted">{t('auth.deviceResetBody')}</p>
        <button
          type="button"
          onClick={() => {
            auth.forgetDevice();
            void navigate('/activate', { replace: true });
          }}
          className="h-14 rounded-2xl bg-primary text-[17px] font-bold text-primary-foreground"
        >
          {t('auth.haveNewCode')}
        </button>
      </AuthShell>
    );
  }

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await auth.login(value);
      void navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'auth.device_reset_needed') {
        setResetNeeded(true);
        return;
      }
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
        <h1 className="text-[22px] font-semibold leading-snug">{t('auth.pinTitle')}</h1>
        <p className="mt-1 text-[13px] leading-normal text-muted">
          {t('auth.pinHint')} · {auth.memberRef}
        </p>
      </div>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(p) => void submit(p)} disabled={busy} invalid={!!error} />
      <FieldError message={error?.message ?? null} requestId={error?.requestId} />
      <button type="button" className="text-sm text-muted underline" onClick={() => setResetNeeded(true)}>
        {t('auth.forgotPin')}
      </button>
    </AuthShell>
  );
}
