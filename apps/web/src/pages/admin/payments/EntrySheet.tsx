import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../../components/ConfirmSheet';
import { api } from '../../../lib/api';
import { uuid } from '../../../lib/uuid';
import { errorMessage } from '../../../lib/errors';
import { dayToIso, fmtDate, todayDhaka } from '../../../lib/dates';
import { paisaToDecimal, parseAmountInput, taka } from '../../../lib/money';
import type { MemberRow, ParsedSms } from '../../../lib/types';

type Purpose = 'dues' | 'special' | 'levy' | 'entry';
const PURPOSE_LABEL: Record<Purpose, string> = {
  dues: 'pay.purposeDues',
  special: 'pay.purposeSpecial',
  levy: 'pay.purposeLevy',
  entry: 'paymentsPage.purposeEntry',
};

interface EntryQuote {
  shares: number;
  price_paisa: string;
  paid_paisa: string;
  outstanding_paisa: string;
  pay_by: string;
  expired: boolean;
}

export interface EntryPrefill {
  parsed?: ParsedSms;
  rawSms?: string;
}

/**
 * Cashier entry: create and confirm a payment in one step (spec 5.4). Used for cash taken in hand
 * and for a pasted SMS. The summary names the effect; nothing is posted until the server answers.
 * A prospective member can only pay their entry price, within the quote's days; once it has lapsed
 * the cashier makes a new quote at today's price first (5.9). A member with an open special
 * contribution or levy picks what the money is for, so it never lands on the monthly dues.
 */
export function EntrySheet({ open, onClose, prefill, onDone }: { open: boolean; onClose: () => void; prefill: EntryPrefill | null; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [trx, setTrx] = useState('');
  const [date, setDate] = useState(todayDhaka());
  const [purpose, setPurpose] = useState<Purpose>('dues');
  const [requoteError, setRequoteError] = useState<unknown>(null);
  const [requoting, setRequoting] = useState(false);
  const key = useRef(uuid());

  useEffect(() => {
    if (!open) return;
    key.current = uuid();
    const p = prefill?.parsed;
    const byPhone = p?.counterparty_phone ? members.data?.items.find((m) => m.phone === p.counterparty_phone)?.id : undefined;
    const byMatch = p?.matches.find((m) => m.exact)?.member_id ?? p?.matches[0]?.member_id;
    setMemberId(byMatch ?? byPhone ?? '');
    setAmount(p?.amount_paisa ? paisaToDecimal(p.amount_paisa) : '');
    setMethod(p?.method ?? 'cash');
    setTrx(p?.trx_id ?? '');
    setDate(p?.paid_at ? p.paid_at.slice(0, 10) : todayDhaka());
  }, [open, prefill, members.data]);

  const member = members.data?.items.find((m) => m.id === memberId);
  const prospective = member?.status === 'prospective';
  const detail = useQuery({
    queryKey: ['member', memberId],
    queryFn: () => api<{ dues: Array<{ kind: string; outstanding_paisa: string }> }>(`/members/${memberId}`),
    enabled: open && !!memberId && !prospective,
  });
  const quote = useQuery({
    queryKey: ['entry-quote', memberId],
    queryFn: () => api<{ quote: EntryQuote | null }>(`/members/${memberId}/entry-quote`),
    enabled: open && prospective,
  });
  const q = quote.data?.quote ?? null;

  const purposes: Purpose[] = prospective
    ? ['entry']
    : ['dues', ...(['special', 'levy'] as const).filter((k) => detail.data?.dues.some((d) => d.kind === k && BigInt(d.outstanding_paisa) > 0n))];
  useEffect(() => {
    setPurpose(prospective ? 'entry' : 'dues');
    setRequoteError(null);
  }, [memberId, prospective]);
  // The entry price is not typed: it is what the quote still asks for.
  useEffect(() => {
    if (purpose === 'entry' && q && !q.expired && !prefill?.parsed?.amount_paisa) setAmount(paisaToDecimal(q.outstanding_paisa));
  }, [purpose, q, prefill]);

  const requote = async () => {
    setRequoting(true);
    setRequoteError(null);
    try {
      await api(`/members/${memberId}/entry-quote`, { method: 'POST', body: {} });
      await quote.refetch();
    } catch (err) {
      setRequoteError(err);
    } finally {
      setRequoting(false);
    }
  };

  const paisa = parseAmountInput(amount);
  const needsTrx = method === 'bkash' || method === 'nagad' || method === 'bank';
  const entryBlocked = purpose === 'entry' && (!q || date > q.pay_by);
  const valid = !!paisa && !!memberId && date <= todayDhaka() && (!needsTrx || trx.trim() !== '') && !entryBlocked;

  const submit = async () => {
    await api('/payments/cashier-entry', {
      method: 'POST',
      headers: { 'Idempotency-Key': key.current },
      body: {
        member_id: memberId,
        amount_paisa: paisa,
        method,
        ...(trx.trim() ? { trx_id: trx.trim() } : {}),
        paid_at: dayToIso(date),
        ...(purpose !== 'dues' ? { purpose } : {}),
        ...(prefill?.rawSms ? { raw_sms: prefill.rawSms } : {}),
      },
    });
    await qc.invalidateQueries();
    onDone();
  };

  const field = 'field w-full';
  return (
    <ConfirmSheet open={open} onClose={onClose} title={t('paymentsPage.entryTitle')} confirmLabel={t('paymentsPage.entryRecord')} canConfirm={valid} onConfirm={submit}>
      <label className="block text-sm text-muted">
        {t('paymentsPage.entryMember')}
        <select className={field} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">{t('paymentsPage.entryChoose')}</option>
          {members.data?.items.map((m) => (
            <option key={m.id} value={m.id}>{m.code} {m.full_name}{m.status === 'prospective' ? ` · ${t('paymentsPage.prospective')}` : ''}</option>
          ))}
        </select>
      </label>
      {purposes.length > 1 && (
        <label className="block text-sm text-muted">
          {t('pay.purposeLabel')}
          <select className={field} value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
            {purposes.map((p) => (
              <option key={p} value={p}>{t(PURPOSE_LABEL[p])}</option>
            ))}
          </select>
        </label>
      )}
      {prospective && (
        <div className="rounded-md bg-background p-3 text-sm">
          {!q ? (
            <p className="text-muted">{quote.isLoading ? '…' : t('paymentsPage.noQuote')}</p>
          ) : (
            <>
              <SheetRow label={t('paymentsPage.quotePrice', { shares: q.shares })} value={taka(q.price_paisa)} />
              {BigInt(q.paid_paisa) > 0n && <SheetRow label={t('paymentsPage.quotePaid')} value={taka(q.paid_paisa)} />}
              <SheetRow label={t('paymentsPage.quoteLeft')} value={taka(q.outstanding_paisa)} strong />
              <SheetRow label={t('paymentsPage.quotePayBy')} value={fmtDate(q.pay_by)} />
              {q.expired ? (
                <div className="mt-2 space-y-2">
                  <p className="text-warn">{t('paymentsPage.quoteExpired')}</p>
                  <button type="button" disabled={requoting} onClick={() => void requote()} className="h-11 w-full rounded-md border border-border font-semibold text-primary">
                    {t('paymentsPage.requote')}
                  </button>
                  {requoteError != null && <p role="alert" className="text-bad">{errorMessage(t, requoteError).message}</p>}
                </div>
              ) : (
                date > q.pay_by && <p className="mt-2 text-warn">{t('paymentsPage.quoteDateLate')}</p>
              )}
            </>
          )}
        </div>
      )}
      <label className="block text-sm text-muted">
        {t('payment.amount')} (৳)
        <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="block text-sm text-muted">
        {t('payment.method')}
        <select className={field} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m].bn}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm text-muted">
        {t('payment.trxId')}
        <input className={field} value={trx} onChange={(e) => setTrx(e.target.value)} autoComplete="off" />
      </label>
      <label className="block text-sm text-muted">
        {t('paymentsPage.entryPaidAt')}
        <input className={field} type="date" max={todayDhaka()} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {valid && member && (
        <div className="rounded-md bg-background p-3">
          <SheetRow label={`${member.code} ${member.full_name}`} value={taka(paisa as string)} strong />
          {purpose !== 'dues' && <SheetRow label={t('pay.purposeLabel')} value={t(PURPOSE_LABEL[purpose])} />}
          <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
          <SheetRow label={t('paymentsPage.paidAt')} value={fmtDate(date)} />
        </div>
      )}
      <p className="text-warn">{t('paymentsPage.entryWarn')}</p>
    </ConfirmSheet>
  );
}
