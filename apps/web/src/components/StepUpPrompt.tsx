import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setStepUpAsker } from '../lib/api';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/errors';

/**
 * Asks for the authenticator code on top of whatever dialog is open, when a privileged action needs
 * the 12 h step-up. On a good code the API client sends the same request again (`setStepUpAsker`),
 * so the action finishes without leaving the screen. Cancel gives the original error back.
 */
export function StepUpPrompt() {
  const { t } = useTranslation();
  const { refreshMe } = useAuth();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const settle = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpAsker(
      () =>
        new Promise<boolean>((resolve) => {
          settle.current = resolve;
          setCode('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setStepUpAsker(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    settle.current?.(ok);
    settle.current = null;
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/totp/verify', { method: 'POST', body: { code } });
      await refreshMe().catch(() => undefined);
      finish(true);
    } catch (err) {
      setError(errorMessage(t, err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && finish(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-4 shadow-lg"
        >
          <Dialog.Title className="text-lg font-semibold">{t('totp.title')}</Dialog.Title>
          <p className="mt-1 text-sm text-muted">{t('totp.stepUpHint')}</p>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6 && !busy) void verify();
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              aria-label={t('totp.code')}
              placeholder="••••••"
              className="field field-lg text-center text-2xl tracking-[0.4em]"
            />
            {error && (
              <p role="alert" className="text-sm text-bad">
                {error.message}
                {error.requestId && <span className="mt-1 block select-all text-muted">{t('errors.requestId')}: {error.requestId}</span>}
              </p>
            )}
            <div className="flex gap-3">
              <button type="button" disabled={busy} onClick={() => finish(false)} className="h-12 flex-1 rounded-md border border-border">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || code.length !== 6} className="h-12 flex-1 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
                {busy ? t('common.working') : t('totp.verify')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
