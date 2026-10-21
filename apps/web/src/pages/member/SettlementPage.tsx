import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { PAYMENT_METHODS } from '@barakah/shared';
import { AdminDialog, BTN_PRIMARY, BTN_SECONDARY } from '../../components/admin';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { useCashByMethod } from '../../lib/useCashByMethod';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { negClass, paisaToDecimal, parseAmountInput, taka } from '../../lib/money';
import type { SettlementView } from '../../lib/types';

/** The caller's settlements (everyone's for the cashier and auditor): the numbers that were voted on. */
export function SettlementPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['settlements'], queryFn: () => api<{ items: SettlementView[] }>('/settlements') });

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/menu"
          aria-label={t('common.back')}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="flex-1 pl-1">
          <div className="text-[1.1875rem] font-bold leading-tight">{t('settlement.title')}</div>
          <div className="text-[0.8125rem] text-muted">{t('settlement.subtitle')}</div>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {q.error ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <ListSkeleton rows={4} />
        ) : q.data.items.length === 0 ? (
          <Empty text={t('settlement.empty')} />
        ) : (
          q.data.items.map((s) => <SettlementCard key={s.id} s={s} />)
        )}
        <p className="text-xs text-muted">{t('settlement.disclaimer')}</p>
      </main>
    </div>
  );
}

export function SettlementCard({ s }: { s: SettlementView }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [paying, setPaying] = useState<SettlementView['payouts'][number] | null>(null);
  const lines: Array<{ label: string; value: string; className: string }> = [
    { label: t('settlement.gross'), value: taka(BigInt(s.gross_paisa)), className: '' },
    ...(BigInt(s.escrow_paisa) > 0n ? [{ label: t('settlement.escrow'), value: taka(BigInt(s.escrow_paisa)), className: '' }] : []),
    ...(BigInt(s.principal_paisa) > 0n ? [{ label: t('settlement.unpaidDues'), value: `−${taka(BigInt(s.principal_paisa))}`, className: 'text-bad' }] : []),
    ...(BigInt(s.fines_paisa) > 0n ? [{ label: t('settlement.unpaidFines'), value: `−${taka(BigInt(s.fines_paisa))}`, className: 'text-bad' }] : []),
    ...(BigInt(s.exit_fee_paisa) > 0n ? [{ label: t('settlement.serviceCharge'), value: `−${taka(BigInt(s.exit_fee_paisa))}`, className: 'text-bad' }] : []),
  ];

  return (
    <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm" data-testid="settlement-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[1.0625rem] font-bold">{s.member_code} · {s.member_name}</div>
          <div className="text-[0.8125rem] text-muted">{t(`settlementKind.${s.kind}`)} · {fmtDate(s.taken_on)}</div>
        </div>
        <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold">{t(`settlement.status.${s.status}`)}</span>
      </div>

      <ul>
        {lines.map((l) => (
          <li key={l.label} className={`flex justify-between gap-3 border-t border-border py-2.5 text-[0.9375rem] first:border-t-0 ${l.className}`}>
            <span>{l.label}</span>
            <span>{l.value}</span>
          </li>
        ))}
        <li className="flex justify-between gap-3 border-t border-border py-2.5 text-[0.9375rem] font-bold text-ok">
          <span>{t('settlement.netRefund')}</span>
          <span>{taka(BigInt(s.net_paisa))}</span>
        </li>
      </ul>

      <h2 className="mb-1 mt-3 text-sm font-bold">{t('settlement.payoutPlan')}</h2>
      <ul className="text-[0.9375rem]">
        {s.payouts.map((p) => (
          <li key={p.due_on} className="flex items-center justify-between gap-3 border-t border-border py-2 first:border-t-0">
            <span>{fmtDate(p.due_on)}{p.paid_at ? ` · ${t('settlement.paid')}` : ''}</span>
            <span className="flex items-center gap-2">
              {taka(BigInt(p.amount_paisa))}
              {isCashier && p.id && !p.paid_at && (
                <button type="button" className={BTN_PRIMARY} data-testid="payout-open" onClick={() => setPaying(p)}>
                  {t('settlement.payNow')}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {paying?.id && <PayoutDialog settlementId={s.id} payout={paying} onClose={() => setPaying(null)} />}
    </section>
  );
}

/** The cashier records money handed to the member: the books move it from "owed to the member" to the chosen account. */
function PayoutDialog({ settlementId, payout, onClose }: { settlementId: string; payout: SettlementView['payouts'][number]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(paisaToDecimal(BigInt(payout.amount_paisa)));
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('cash');
  const [trxId, setTrxId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The fund pays only what it holds: the chosen account with per-method tracking on, else cash and bank together.
  const balances = useQuery({ queryKey: ['balances'], queryFn: () => api<{ items: Array<{ code: string; natural_balance_paisa: string }> }>('/accounts/balances') });
  const perMethod = useCashByMethod();
  const account = { bkash: 'BKASH', nagad: 'NAGAD', cash: 'CASH', bank: 'BANK', other: 'BANK' }[method];
  const held = (code: string) => BigInt(balances.data?.items.find((a) => a.code === code)?.natural_balance_paisa ?? '0');
  const available = balances.data ? (perMethod ? held(account) : ['CASH', 'BANK', 'BKASH', 'NAGAD'].reduce((sum, c) => sum + held(c), 0n)) : null;
  const wanted = parseAmountInput(amount);
  const tooMuch = available !== null && wanted !== null && BigInt(wanted) > available;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const paisa = parseAmountInput(amount);
      if (!paisa) throw new ApiError(400, 'request.invalid', t('pay.invalidAmount'));
      await api(`/settlements/${settlementId}/payouts`, {
        method: 'POST',
        body: { payout_id: payout.id, amount_paisa: paisa, method, ...(trxId.trim() ? { trx_id: trxId.trim() } : {}) },
      });
      void qc.invalidateQueries();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminDialog open onClose={onClose} title={t('settlement.payNow')}>
      <p className="mb-3 text-muted">{t('settlement.payHint')}</p>
      {available !== null && (
        <p className="mb-2 text-sm">{t('settlement.payAvailable', { account: perMethod ? t(`cashAccount.${account}`) : t('adminDash.cashAndBank') })}: <strong className={negClass(available)}>{taka(available)}</strong></p>
      )}
      <label className="block text-sm text-muted">
        {t('settlement.payAmount')}
        <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('settlement.payMethod')}
        <select className="field mt-1 w-full" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>{t(`payment.methods.${m}`)}</option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('settlement.payTrx')}
        <input className="field mt-1 w-full" value={trxId} onChange={(e) => setTrxId(e.target.value)} />
      </label>
      {tooMuch && <p className="mt-2 text-bad" data-testid="payout-short">{t('settlement.payShort')}</p>}
      {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy || tooMuch} onClick={() => void submit()} className={`${BTN_PRIMARY} flex-1`} data-testid="payout-submit">
          {busy ? t('common.working') : t('common.confirm')}
        </button>
        <Dialog.Close className={`${BTN_SECONDARY} flex-1`}>{t('common.cancel')}</Dialog.Close>
      </div>
    </AdminDialog>
  );
}
