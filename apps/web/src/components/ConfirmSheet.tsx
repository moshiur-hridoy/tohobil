import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';

const STEP_UP_CODES = new Set(['auth.step_up_required', 'auth.totp_enrollment_required']);

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** What the action will do, in plain words: "Every action that changes money shows a confirmation sheet" (spec 8). */
  children: ReactNode;
  confirmLabel: string;
  /** Runs the request. The sheet stays open and busy until it settles: no optimistic UI for money. */
  onConfirm: () => Promise<void>;
  tone?: 'primary' | 'danger';
  /** Disable confirm until the content is valid (for example a reason of 3 characters). */
  canConfirm?: boolean;
}

/**
 * Bottom sheet (full dialog on wide screens) that summarises a money action and waits for the server.
 * A failure is shown inside the sheet in Bengali with the request id; a missing authenticator code
 * links to the TOTP screen.
 */
export function ConfirmSheet({ open, onClose, title, children, confirmLabel, onConfirm, tone = 'primary', canConfirm = true }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const shown = error ? errorMessage(t, error) : null;
  const needsStepUp = error instanceof ApiError && STEP_UP_CODES.has(error.code);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-lg sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          <Dialog.Title className="mb-3 text-lg font-semibold">{title}</Dialog.Title>
          <div className="space-y-2">{children}</div>

          {shown && (
            <div role="alert" className="mt-3 rounded-md border border-border p-3">
              <p className="text-bad">{shown.message}</p>
              {shown.requestId && (
                <p className="mt-1 select-all text-sm text-muted">
                  {t('errors.requestId')}: {shown.requestId}
                </p>
              )}
              {needsStepUp && (
                <Link to="/totp" className="mt-2 inline-block font-medium text-primary underline">
                  {t('common.goToTotp')}
                </Link>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-3">
            <button type="button" disabled={busy} onClick={onClose} className="h-12 flex-1 rounded-md border border-border">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={busy || !canConfirm}
              onClick={() => void run()}
              className={`h-12 flex-1 rounded-md font-medium disabled:opacity-50 ${tone === 'danger' ? 'bg-bad text-primary-foreground' : 'bg-primary text-primary-foreground'}`}
            >
              {busy ? t('common.working') : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One "label ... value" line inside a confirmation sheet. */
export function SheetRow({ label, value, strong = false }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className={strong ? 'text-lg font-semibold' : 'font-medium'}>{value}</span>
    </div>
  );
}
