import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isValidPin, normalizeActivationCode } from '@barakah/shared';
import { AuthShell, FieldError } from '../../components/AuthShell';
import { PinPad } from '../../components/PinPad';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';

type Step = 'code' | 'pin' | 'confirm';

/** Activation (spec 19.1): member ID + code from the cashier, then the member chooses their own PIN. */
export function ActivationPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // The QR payload barakah://activate?ref=M01&code=... opens this route as /activate?ref=&code=.
  const [ref, setRef] = useState((params.get('ref') ?? '').toUpperCase());
  const [code, setCode] = useState(params.get('code') ?? '');
  const [step, setStep] = useState<Step>('code');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;

  const codeOk = /^M\d{2}$/.test(ref.trim().toUpperCase()) && normalizeActivationCode(code).length === 8;

  const submit = async (finalPin: string) => {
    setBusy(true);
    setError(null);
    try {
      await auth.activate({
        member_ref: ref.trim().toUpperCase(),
        code: normalizeActivationCode(code),
        pin: finalPin,
      });
      void navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(t, err));
      setPin('');
      setConfirm('');
      setStep('code'); // the code may be wrong or expired: let them fix it
    } finally {
      setBusy(false);
    }
  };

  const steps: Step[] = ['code', 'pin', 'confirm'];
  const stepIndex = steps.indexOf(step);

  return (
    <AuthShell footer={t('auth.activateFooter')}>
      <ol className="flex items-center gap-2 text-[13px] text-muted" aria-label={t('auth.steps')}>
        {steps.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className={`grid h-[22px] w-[22px] place-items-center rounded-full text-xs font-bold ${
                i <= stepIndex ? 'bg-primary text-primary-foreground' : 'bg-hover'
              }`}
            >
              {i < stepIndex ? '✓' : i + 1}
            </span>
            <span className={i === stepIndex ? 'font-bold text-foreground' : ''}>{t(`auth.step.${s}`)}</span>
            {i < steps.length - 1 && <span className="h-0.5 flex-1 rounded bg-border" />}
          </li>
        ))}
      </ol>

      {step === 'code' && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (codeOk) {
              setError(null);
              setStep('pin');
            }
          }}
        >
          <div>
            <h1 className="text-[22px] font-semibold leading-snug">{t('auth.activateTitle')}</h1>
            <p className="mt-1 text-[13px] leading-normal text-muted">{t('auth.activateHint')}</p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {t('auth.memberRef')}
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value.toUpperCase())}
              placeholder="M01"
              autoComplete="username"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={3}
              className="h-14 rounded-2xl border border-input bg-background px-4 text-center text-xl uppercase tracking-widest"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('auth.activateCode')}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={12}
              className="h-14 rounded-2xl border border-input bg-background px-4 text-center text-xl uppercase tracking-[0.3em]"
            />
          </label>
          <FieldError message={error?.message ?? null} requestId={error?.requestId} />
          <button
            type="submit"
            disabled={!codeOk}
            className="h-14 rounded-2xl bg-primary text-[17px] font-bold text-primary-foreground disabled:opacity-50"
          >
            {t('common.next')}
          </button>
        </form>
      )}

      {step === 'pin' && (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-[22px] font-semibold leading-snug">{t('auth.setPinTitle')}</h1>
            <p className="mt-1 text-[13px] leading-normal text-muted">{t('auth.setPinHint')}</p>
          </div>
          <PinPad
            value={pin}
            onChange={(v) => {
              setPin(v);
              setError(null);
            }}
            onComplete={(p) => {
              if (isValidPin(p)) setStep('confirm');
              else setError({ message: t('auth.pinTooWeak') });
            }}
            invalid={!!error}
          />
          <FieldError message={error?.message ?? null} />
          {error && (
            <button type="button" className="text-sm font-bold text-primary" onClick={() => { setPin(''); setError(null); }}>
              {t('auth.tryAnotherPin')}
            </button>
          )}
        </div>
      )}

      {step === 'confirm' && (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-[22px] font-semibold leading-snug">{t('auth.confirmPinTitle')}</h1>
            <p className="mt-1 text-[13px] leading-normal text-muted">{t('auth.confirmPinHint')}</p>
          </div>
          <PinPad
            value={confirm}
            onChange={(v) => {
              setConfirm(v);
              setError(null);
            }}
            disabled={busy}
            invalid={!!error}
            onComplete={(p) => {
              if (p === pin) void submit(p);
              else {
                setError({ message: t('auth.pinMismatch') });
                setConfirm('');
              }
            }}
          />
          <FieldError message={error?.message ?? null} requestId={error?.requestId} />
        </div>
      )}
    </AuthShell>
  );
}
