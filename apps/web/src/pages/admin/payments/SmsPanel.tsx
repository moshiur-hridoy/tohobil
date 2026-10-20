import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS } from '@barakah/shared';
import { api } from '../../../lib/api';
import { fmtInstant } from '../../../lib/dates';
import { taka } from '../../../lib/money';
import type { ParsedSms } from '../../../lib/types';
import { LoadError } from '../../../components/StateViews';

export interface SmsResult {
  text: string;
  result: ParsedSms;
}

/**
 * "Paste SMS" (spec 8): one or more messages separated by an empty line. Each is read by the server,
 * which only suggests; the cashier creates the entry or approves the highlighted pending payment.
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
    <section className="rounded-[18px] border border-border bg-card shadow-card p-4" aria-labelledby="sms-title">
      <h2 id="sms-title" className="font-semibold">{t('paymentsPage.pasteSms')}</h2>
      <p className="mb-2 text-sm text-muted">{t('paymentsPage.pasteHint')}</p>
      <textarea
        aria-label={t('paymentsPage.pasteSms')}
        className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={5000}
      />
      <button type="button" disabled={busy || !text.trim()} onClick={() => void parse()} className="mt-2 h-11 rounded-xl bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">
        {busy ? t('common.working') : t('paymentsPage.parse')}
      </button>
      {error != null && <div className="mt-2"><LoadError error={error} /></div>}
      {error == null && results.length > 0 && (
        <ul className="mt-3 space-y-3">
          {results.map((r, i) => (
            <li key={i} className="rounded-xl border border-border p-3 text-sm">
              {!r.result.parsed ? (
                <p className="text-warn">{t('paymentsPage.notParsed')}</p>
              ) : (
                <>
                  <p className="font-medium">
                    {r.result.amount_paisa && taka(r.result.amount_paisa)} · {r.result.method && PAYMENT_METHOD_LABELS[r.result.method].bn}
                    {r.result.trx_id && <> · {t('paymentsPage.trxId')} <span className="select-all">{r.result.trx_id}</span></>}
                  </p>
                  <p className="text-muted">
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
                        <span key={m.payment_id} className={`mr-2 ${m.exact ? 'font-medium text-ok' : 'text-warn'}`}>
                          {m.member_code} {m.exact ? t('paymentsPage.exactMatch') : t('paymentsPage.possibleMatch')}
                        </span>
                      ))}
                    </p>
                  )}
                  <button type="button" onClick={() => onCreate(r)} className="mt-2 h-10 rounded-xl border border-border px-3">
                    {t('paymentsPage.createFromSms')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

