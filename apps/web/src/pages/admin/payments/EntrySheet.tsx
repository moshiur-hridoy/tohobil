import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../../components/ConfirmSheet';
import { api } from '../../../lib/api';
import { dayToIso, fmtDate, todayDhaka } from '../../../lib/dates';
import { paisaToDecimal, parseAmountInput, taka } from '../../../lib/money';
import type { MemberRow, ParsedSms } from '../../../lib/types';

export interface EntryPrefill {
  parsed?: ParsedSms;
  rawSms?: string;
}

/**
 * Cashier entry: create and confirm a payment in one step (spec 5.4). Used for cash taken in hand
 * and for a pasted SMS. The summary names the effect; nothing is posted until the server answers.
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
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    key.current = crypto.randomUUID();
    const p = prefill?.parsed;
    const byPhone = p?.counterparty_phone ? members.data?.items.find((m) => m.phone === p.counterparty_phone)?.id : undefined;
    const byMatch = p?.matches.find((m) => m.exact)?.member_id ?? p?.matches[0]?.member_id;
    setMemberId(byMatch ?? byPhone ?? '');
    setAmount(p?.amount_paisa ? paisaToDecimal(p.amount_paisa) : '');
    setMethod(p?.method ?? 'cash');
    setTrx(p?.trx_id ?? '');
    setDate(p?.paid_at ? p.paid_at.slice(0, 10) : todayDhaka());
  }, [open, prefill, members.data]);

  const paisa = parseAmountInput(amount);
  const needsTrx = method === 'bkash' || method === 'nagad' || method === 'bank';
  const member = members.data?.items.find((m) => m.id === memberId);
  const valid = !!paisa && !!memberId && date <= todayDhaka() && (!needsTrx || trx.trim() !== '');

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
        ...(prefill?.rawSms ? { raw_sms: prefill.rawSms } : {}),
      },
    });
    await qc.invalidateQueries();
    onDone();
  };

  const field = 'h-11 w-full rounded-md border border-input bg-background px-2';
  return (
    <ConfirmSheet open={open} onClose={onClose} title={t('paymentsPage.entryTitle')} confirmLabel={t('paymentsPage.entryRecord')} canConfirm={valid} onConfirm={submit}>
      <label className="block text-sm text-muted">
        {t('paymentsPage.entryMember')}
        <select className={field} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">{t('paymentsPage.entryChoose')}</option>
          {members.data?.items.map((m) => (
            <option key={m.id} value={m.id}>{m.code} {m.full_name}</option>
          ))}
        </select>
      </label>
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
          <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
          <SheetRow label={t('paymentsPage.paidAt')} value={fmtDate(date)} />
        </div>
      )}
      <p className="text-warn">{t('paymentsPage.entryWarn')}</p>
    </ConfirmSheet>
  );
}
