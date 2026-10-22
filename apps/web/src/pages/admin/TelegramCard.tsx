import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TelegramLinkCode, TelegramStatus } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { BTN_PRIMARY, BTN_SECONDARY, Card, CardHead, FieldLabel, ICONS, Notice } from '../../components/admin';
import { api, ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';

const STEP_UP_CODES = new Set(['auth.step_up_required', 'auth.totp_enrollment_required']);

/** A failed action, in Bengali, with a link to the authenticator screen when that is what is missing. */
export function ActionError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const needsStepUp = error instanceof ApiError && STEP_UP_CODES.has(error.code);
  return (
    <div role="alert" className="mt-3 rounded-xl border border-border p-3 text-sm">
      <p className="text-bad">{errorMessage(t, error).message}</p>
      {needsStepUp && (
        <Link to="/totp" className="mt-1 inline-block font-medium text-primary underline">
          {t('common.goToTotp')}
        </Link>
      )}
    </div>
  );
}

/**
 * Settings card for approving payments from Telegram (docs/ASSUMPTIONS.md 101). The bot token goes in
 * once and is never shown again; the cashier's own Telegram is identified with a one-time code.
 */
export function TelegramCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [link, setLink] = useState<TelegramLinkCode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  // While a link code is open, look for the cashier pressing Start in Telegram.
  const waiting = !!link && new Date(link.expires_at).getTime() > Date.now();
  const status = useQuery({
    queryKey: ['telegram'],
    queryFn: () => api<TelegramStatus>('/telegram'),
    refetchInterval: waiting ? 3000 : false,
  });
  const s = status.data;

  useEffect(() => {
    if (s?.linked) setLink(null);
  }, [s?.linked]);

  const flash = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 3000);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['telegram'] });

  const connect = useMutation({
    mutationFn: () => api<TelegramStatus>('/telegram/token', { method: 'POST', body: { token: token.trim() } }),
    onSuccess: () => {
      setToken('');
      setReplacing(false);
      setLink(null);
      void refresh();
    },
  });
  const makeLink = useMutation({
    mutationFn: () => api<TelegramLinkCode>('/telegram/link-code', { method: 'POST' }),
    onSuccess: (r) => setLink(r),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<TelegramStatus>('/telegram', { method: 'PATCH', body: { enabled } }),
    onSuccess: () => {
      void refresh();
      flash(t('settingsPage.telegram.saved'));
    },
  });
  const test = useMutation({
    mutationFn: () => api('/telegram/test', { method: 'POST' }),
    onSuccess: () => flash(t('settingsPage.telegram.testSent')),
  });
  const disconnect = useMutation({
    mutationFn: () => api('/telegram', { method: 'DELETE' }),
    onSuccess: () => {
      setLink(null);
      void refresh();
    },
  });

  if (status.error) return null;
  const error = connect.error ?? makeLink.error ?? toggle.error ?? test.error;

  return (
    <Card className="p-5">
      <CardHead
        icon={ICONS.message}
        tone="bg-blue-bg text-blue"
        title={t('settingsPage.telegram.title')}
        sub={t('settingsPage.telegram.hint')}
      />
      <Notice text={note} className="mb-3" />

      <h3 className="text-sm font-semibold">{t('settingsPage.telegram.stepToken')}</h3>
      {s?.connected && !replacing ? (
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">{t('settingsPage.telegram.botName', { name: s.bot_username })}</span>
          <span className="text-muted">{t('settingsPage.telegram.tokenSaved')}</span>
          <button type="button" className="text-primary underline" onClick={() => setReplacing(true)}>
            {t('settingsPage.telegram.replaceToken')}
          </button>
        </div>
      ) : (
        <form
          className="mt-1"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
        >
          <p className="mb-2 text-sm text-muted">{t('settingsPage.telegram.stepTokenHint')}</p>
          <FieldLabel label={t('settingsPage.telegram.tokenLabel')}>
            <input
              className="field w-full"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('settingsPage.telegram.tokenPlaceholder')}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </FieldLabel>
          <div className="mt-3 flex gap-2">
            <button type="submit" className={BTN_PRIMARY} disabled={connect.isPending || token.trim().length < 20}>
              {connect.isPending ? t('common.working') : t('settingsPage.telegram.connect')}
            </button>
            {replacing && (
              <button type="button" className={BTN_SECONDARY} onClick={() => setReplacing(false)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </form>
      )}

      {s?.connected && (
        <>
          <h3 className="mt-5 text-sm font-semibold">{t('settingsPage.telegram.stepLink')}</h3>
          {s.linked && !waiting ? (
            <p className="mt-1 text-sm font-medium text-ok">{t('settingsPage.telegram.linkedOk')}</p>
          ) : (
            <p className="mt-1 text-sm text-muted">{t('settingsPage.telegram.stepLinkHint')}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_SECONDARY} disabled={makeLink.isPending} onClick={() => makeLink.mutate()}>
              {t('settingsPage.telegram.linkButton')}
            </button>
            {waiting && link && (
              <>
                <a href={link.link} target="_blank" rel="noreferrer" className={BTN_PRIMARY}>
                  {t('settingsPage.telegram.openTelegram')}
                </a>
                <span className="text-sm text-muted">{t('settingsPage.telegram.linkWaiting')}</span>
              </>
            )}
          </div>

          <h3 className="mt-5 text-sm font-semibold">{t('settingsPage.telegram.stepOn')}</h3>
          <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={s.enabled}
              disabled={!s.linked || toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            <span className="font-medium">{t('settingsPage.telegram.enable')}</span>
          </label>
          <p className="text-sm text-muted">{s.linked ? t('settingsPage.telegram.enableHint') : t('settingsPage.telegram.needLinkFirst')}</p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={BTN_SECONDARY} disabled={!s.linked || test.isPending} onClick={() => test.mutate()}>
              {t('settingsPage.telegram.test')}
            </button>
            <button type="button" className={`${BTN_SECONDARY} text-bad`} onClick={() => setConfirmOff(true)}>
              {t('settingsPage.telegram.disconnect')}
            </button>
          </div>
        </>
      )}

      <ActionError error={error} />
      <p className="mt-3 text-xs text-muted">{t('settingsPage.telegram.stepUpNote')}</p>

      <ConfirmSheet
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={t('settingsPage.telegram.disconnectTitle')}
        confirmLabel={t('settingsPage.telegram.disconnect')}
        tone="danger"
        onConfirm={async () => {
          await disconnect.mutateAsync();
        }}
      >
        <p>{t('settingsPage.telegram.disconnectBody')}</p>
      </ConfirmSheet>
    </Card>
  );
}
