import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enablePush, pushState, type PushState } from '../lib/push';
import { Icon } from './ui';

const BELL = 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7 M10 20a2 2 0 0 0 4 0';
/** "Later" lasts until the app is closed: the next time it opens, the banner is back (ASSUMPTIONS 124). */
const LATER_KEY = 'barakah.pushPrompt.later';

/** States the member can still change; for the others (unsupported, not set up) there is nothing to ask. */
const ASK: ReadonlySet<PushState> = new Set(['off', 'blocked', 'needs-install']);

/**
 * Banner at the top of every page until this phone gets notifications: a button that asks the browser,
 * or the steps to allow them when the browser was told to block them, or (iPhone) to add the app to the
 * Home Screen first. "Remind me later" hides it until the app is opened again; there is no "never".
 */
export function PushPrompt() {
  const { t } = useTranslation();
  const [state, setState] = useState<PushState | null>(null);
  const [later, setLater] = useState(() => sessionStorage.getItem(LATER_KEY) === '1');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (later) return;
    void pushState().then(setState, () => setState(null));
  }, [later]);

  if (later || !state || !ASK.has(state)) return null;

  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      setState(await enablePush());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const remindLater = (): void => {
    sessionStorage.setItem(LATER_KEY, '1');
    setLater(true);
  };

  return (
    <section role="region" aria-label={t('pushPrompt.title')} className="mx-4 mt-3 rounded-[18px] border border-primary bg-primary-soft p-4 lg:mx-6 lg:mt-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-primary text-primary-foreground">
          <Icon d={BELL} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-foreground">{t('pushPrompt.title')}</p>
          <p className="mt-0.5 text-sm text-ink2">{t(`pushPrompt.body.${state}`)}</p>
        </div>
      </div>
      {failed && <p className="mt-2 text-sm text-bad">{t('push.failed')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {state === 'off' && (
          <button type="button" disabled={busy} onClick={() => void turnOn()} className="h-11 flex-1 rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">
            {t('pushPrompt.turnOn')}
          </button>
        )}
        <button type="button" onClick={remindLater} className="h-11 flex-1 rounded-xl border border-border bg-card px-4 font-semibold text-foreground">
          {t('pushPrompt.later')}
        </button>
      </div>
    </section>
  );
}
