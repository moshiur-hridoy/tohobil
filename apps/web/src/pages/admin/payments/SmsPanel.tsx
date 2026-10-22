import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS } from '@barakah/shared';
import { api } from '../../../lib/api';
import { fmtInstant } from '../../../lib/dates';
import { taka } from '../../../lib/money';
import type { ParsedSms } from '../../../lib/types';
import { LoadError } from '../../../components/StateViews';
import { BTN_PRIMARY, BTN_SM } from '../../../components/admin';

export interface SmsResult {
  text: string;
  result: ParsedSms;
}

/**
 * "Paste SMS" (spec 8): one or more messages separated by an empty line. Each is read by the server,
 * which only suggests; the cashier creates the entry or approves the highlighted pending payment.
 * Shown inside a dialog: with Telegram approvals it is the exception, not the daily screen.
 */
export function SmsPanel({ onResults, onCreate }: { onResults: (r: SmsResult[]) => void; onCreate: (r: SmsResult) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [results, setResults] = useState<SmsResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const parse = async () => {
    const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      const out: SmsResult[] = [];
      for (const block of blocks) out.push({ text: block, result: await api<ParsedSms>('/payments/parse-sms', { method: 'POST', body: { text: block } }) });
      setResults(out);
      onResults(out);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('paymentsPage.pasteHint')}</p>
      <div>
          <textarea
            aria-label={t('paymentsPage.pasteSms')}
            className="field min-h-28 w-full font-mono text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={5000}
          />
          <button type="button" disabled={busy || !text.trim()} onClick={() => void parse()} className={`${BTN_PRIMARY} mt-2`}>
            {busy ? t('common.working') : t('paymentsPage.parse')}
          </button>
      </div>
        <div className="min-w-0">
          {error != null && <LoadError error={error} />}
          {error == null && results.length > 0 && (
            <ul className="space-y-3">
              {results.map((r, i) => (
                <li key={i} className={`rounded-xl border p-3 text-sm ${!r.result.parsed ? 'border-warn bg-warn-bg' : r.result.matches.some((m) => m.exact) ? 'border-ok bg-ok-bg' : 'border-border'}`}>
                  {!r.result.parsed ? (
                    <p className="font-medium text-warn">{t('paymentsPage.notParsed')}</p>
                  ) : (
                    <>
                      <p className="font-semibold">
                        {r.result.amount_paisa && taka(r.result.amount_paisa)} · {r.result.method && PAYMENT_METHOD_LABELS[r.result.method].bn}
                        {r.result.trx_id && <> · {t('paymentsPage.trxId')} <span className="select-all font-mono">{r.result.trx_id}</span></>}
                      </p>
                      <p className="text-ink2">
                        {r.result.paid_at && <>{t('paymentsPage.paidAt')}: {fmtInstant(r.result.paid_at)} </>}
                        {r.result.counterparty_phone && <>· {t('paymentsPage.counterparty')}: {r.result.counterparty_phone} </>}
                        {r.result.balance_paisa && <>· {t('paymentsPage.balance')}: {taka(r.result.balance_paisa)}</>}
                      </p>
                      {r.result.matches.length === 0 ? (
                        <p className="mt-1 text-muted">{t('paymentsPage.noMatch')}</p>
                      ) : (
                        <p className="mt-1">
                          {t('paymentsPage.matches')}:{' '}
                          {r.result.matches.map((m) => (
                            <span key={m.payment_id} className={`mr-2 ${m.exact ? 'font-semibold text-ok' : 'text-warn'}`}>
                              {m.member_code} {m.exact ? t('paymentsPage.exactMatch') : t('paymentsPage.possibleMatch')}
                            </span>
                          ))}
                        </p>
                      )}
                      <button type="button" onClick={() => onCreate(r)} className={`${BTN_SM} mt-2`}>
                        {t('paymentsPage.createFromSms')}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
    </div>
  );
}
