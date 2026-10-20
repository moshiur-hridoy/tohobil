import { useTranslation } from 'react-i18next';
import { errorMessage } from '../lib/errors';

/** A failed load: Bengali message, the request id to quote (spec 8) and a retry button. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const { message, requestId } = errorMessage(t, error);
  return (
    <div role="alert" className="rounded-lg border border-border bg-card p-4">
      <p className="text-bad">{message}</p>
      {requestId && (
        <p className="mt-1 select-all text-sm text-muted">
          {t('errors.requestId')}: {requestId}
        </p>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 h-11 rounded-md border border-border px-4">
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-border p-6 text-center text-muted">{text}</p>;
}
