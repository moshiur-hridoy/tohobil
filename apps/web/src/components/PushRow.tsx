import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { Chip, Switch } from './ui';

const BELL = 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2z M10 21h4';

/** Settings row: turn phone notifications on or off for this device. Explains why when it cannot. */
export function PushRow({ className = '' }: { className?: string }) {
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
    <div className={className}>
      <div className="flex min-h-11 items-center gap-3">
        <Chip tone="bg-soft text-ink2" d={BELL} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('push.title')}</p>
          <p className={`text-sm ${state === 'on' ? 'text-ok' : 'text-muted'}`}>{t(`push.state.${state}`)}</p>
        </div>
        {canToggle && <Switch checked={state === 'on'} disabled={busy} onChange={() => void toggle()} label={t('push.title')} />}
      </div>
      {failed && <p className="mt-2 pl-12 text-sm text-bad">{t('push.failed')}</p>}
    </div>
  );
}
