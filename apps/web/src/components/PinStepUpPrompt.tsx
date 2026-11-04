import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setPinAsker, type PinAttempt } from '../lib/api';
import { localDigits } from '../lib/format';

/**
 * The auditor confirms each privileged action by typing their PIN again, on top of whatever dialog
 * is open (owner decision, ASSUMPTIONS.md 117). A wrong PIN stays here with the tries left; anything
 * else (done, refused for its own reason, or locked) closes and goes back to the screen. Nothing is
 * remembered, so the next action asks again. Cancel gives the original error back.
 */
export function PinStepUpPrompt() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ attempt: PinAttempt; settle: (res: Response | null) => void } | null>(null);

  useEffect(() => {
    setPinAsker(
      (attempt) =>
        new Promise<Response | null>((settle) => {
          pending.current = { attempt, settle };
          setPin('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setPinAsker(null);
  }, []);

  const finish = (res: Response | null) => {
    setOpen(false);
    setPin('');
    pending.current?.settle(res);
    pending.current = null;
  };

  const submit = async () => {
    const current = pending.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await current.attempt(pin);
      if (res.status === 401) {
        const body = (await res.clone().json().catch(() => null)) as { code?: string; attempts_left?: number } | null;
        if (body?.code === 'auth.invalid_credentials') {
          setError(
            typeof body.attempts_left === 'number'
              ? t('pinStepUp.wrongLeft', { n: localDigits(String(body.attempts_left)) })
              : t('pinStepUp.wrong'),
          );
          setPin('');
          return;
        }
      }
      finish(res);
    } catch {
      setError(t('errors.network'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && finish(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-4 shadow-lg"
        >
          <Dialog.Title className="text-lg font-semibold">{t('pinStepUp.title')}</Dialog.Title>
          <p className="mt-1 text-sm text-muted">{t('pinStepUp.hint')}</p>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (pin.length === 6 && !busy) void submit();
            }}
          >
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              autoFocus
              aria-label={t('pinStepUp.pin')}
              placeholder="••••••"
              className="field field-lg text-center text-2xl tracking-[0.4em]"
            />
            {error && (
              <p role="alert" className="text-sm text-bad">
                {error}
              </p>
            )}
            <div className="flex gap-3">
              <button type="button" disabled={busy} onClick={() => finish(null)} className="h-12 flex-1 rounded-md border border-border">
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || pin.length !== 6} className="h-12 flex-1 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
                {busy ? t('common.working') : t('pinStepUp.confirm')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
