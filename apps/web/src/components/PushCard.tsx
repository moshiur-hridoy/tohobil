import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';

const CARD = 'overflow-clip rounded-[20px] border border-border bg-card p-4';

/** Menu card: turn phone notifications on or off for this device. */
export function PushCard() {
  const { t } = useTranslation();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void pushState().then(setState, () => setState('unsupported'));
  }, []);

  if (!state) return null;

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      setState(state === 'on' ? await disablePush() : await enablePush());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const canToggle = state === 'on' || state === 'off';
  return (
    <div className={CARD}>
      <div className="card-head mb-3 pb-3">
        <h2 className="text-base font-bold">{t('push.title')}</h2>
        <p className="text-sm text-muted">{t(`push.state.${state}`)}</p>
      </div>
      {canToggle && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          className={`min-h-11 w-full rounded-2xl px-4 font-semibold disabled:opacity-50 ${state === 'on' ? 'border border-border' : 'bg-primary text-primary-foreground'}`}
        >
          {t(state === 'on' ? 'push.turnOff' : 'push.turnOn')}
        </button>
      )}
      {failed && <p className="mt-2 text-sm text-bad">{t('push.failed')}</p>}
    </div>
  );
}
