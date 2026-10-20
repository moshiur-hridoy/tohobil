import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, type PaymentMethod } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, todayDhaka } from '../../lib/dates';
import { parseAmountInput, taka } from '../../lib/money';

interface Stream {
  id: string;
  name: string;
  tenant_name: string | null;
  monthly_amount_paisa: string;
  due_day: number;
  active_from: string;
  active_to: string | null;
  asset_name: string | null;
}

interface Expected {
  id: string;
  stream_name: string;
  tenant_name: string | null;
  period: string;
  amount_paisa: string;
  received_paisa: string;
  due_date: string;
}

/** Cashier: rent streams, what is expected each month, and recording what the tenant paid. */
export function AdminRentPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [period, setPeriod] = useState(todayDhaka().slice(0, 7));
  const [receiving, setReceiving] = useState<Expected | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [paidAt, setPaidAt] = useState(todayDhaka());
  const [name, setName] = useState('');
  const [tenant, setTenant] = useState('');
  const [monthly, setMonthly] = useState('');
  const [dueDay, setDueDay] = useState('5');
  const [from, setFrom] = useState(todayDhaka());

  const streams = useQuery({ queryKey: ['rent-streams'], queryFn: () => api<{ items: Stream[] }>('/rent/streams') });
  const expected = useQuery({
    queryKey: ['rent-expected', period],
    queryFn: () => api<{ items: Expected[] }>(`/rent/expected?period=${period}`),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['rent-streams'] });
    void qc.invalidateQueries({ queryKey: ['rent-expected'] });
  };

  const addStream = async () => {
    await api('/rent/streams', {
      method: 'POST',
      body: { name: name.trim(), tenant_name: tenant.trim() || undefined, monthly_amount_paisa: parseAmountInput(monthly), due_day: Number(dueDay), active_from: from },
    });
    setName('');
    setTenant('');
    setMonthly('');
    refresh();
  };

  const generate = async () => {
    await api('/rent/expected/generate', { method: 'POST', body: { period } });
    refresh();
  };

  const receive = async () => {
    if (!receiving) return;
    await api(`/rent/expected/${receiving.id}/receive`, {
      method: 'POST',
      body: { amount_paisa: parseAmountInput(amount), method, paid_at: paidAt },
    });
    refresh();
  };

  const remaining = (e: Expected) => BigInt(e.amount_paisa) - BigInt(e.received_paisa);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('rentAdmin.title')}</h1>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold">{t('rentAdmin.streams')}</h2>
        {streams.error ? (
          <LoadError error={streams.error} onRetry={() => void streams.refetch()} />
        ) : !streams.data ? (
          <ListSkeleton rows={2} />
        ) : streams.data.items.length === 0 ? (
          <Empty text={t('rentAdmin.noStreams')} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {streams.data.items.map((s) => (
              <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{s.name}</span>
                  {s.tenant_name && <span className="ml-2 text-muted">{s.tenant_name}</span>}
                  {s.asset_name && <span className="ml-2 text-muted">· {s.asset_name}</span>}
                </span>
                <span>{taka(s.monthly_amount_paisa)} · {t('rentAdmin.dueDay', { day: s.due_day })}</span>
              </li>
            ))}
          </ul>
        )}
        {isCashier && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <input aria-label={t('rentAdmin.name')} placeholder={t('rentAdmin.name')} className="h-11 rounded-md border border-input bg-background px-2" value={name} onChange={(e) => setName(e.target.value)} />
            <input aria-label={t('rentAdmin.tenant')} placeholder={t('rentAdmin.tenant')} className="h-11 rounded-md border border-input bg-background px-2" value={tenant} onChange={(e) => setTenant(e.target.value)} />
            <input aria-label={t('rentAdmin.monthly')} placeholder={t('rentAdmin.monthly')} inputMode="decimal" className="h-11 rounded-md border border-input bg-background px-2" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
            <input aria-label={t('rentAdmin.dueDayLabel')} type="number" min={1} max={28} className="h-11 rounded-md border border-input bg-background px-2" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            <input aria-label={t('rentAdmin.activeFrom')} type="date" className="h-11 rounded-md border border-input bg-background px-2" value={from} onChange={(e) => setFrom(e.target.value)} />
            <button type="button" disabled={!name.trim() || parseAmountInput(monthly) === null} onClick={() => void addStream()} className="h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50 sm:col-span-2 lg:col-span-5">
              {t('rentAdmin.addStream')}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('rentAdmin.expected')}</h2>
          <div className="flex items-center gap-2">
            <input type="month" aria-label={t('rentAdmin.period')} className="h-11 rounded-md border border-input bg-background px-2" value={period} onChange={(e) => setPeriod(e.target.value)} />
            {isCashier && <button type="button" onClick={() => void generate()} className="h-11 rounded-md border border-border px-3 text-sm hover:bg-hover">{t('rentAdmin.generate')}</button>}
          </div>
        </div>
        {expected.error ? (
          <LoadError error={expected.error} onRetry={() => void expected.refetch()} />
        ) : !expected.data ? (
          <ListSkeleton rows={2} />
        ) : expected.data.items.length === 0 ? (
          <Empty text={t('rentAdmin.noExpected')} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {expected.data.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-2" data-testid="rent-expected">
                <span>
                  <span className="font-medium">{e.stream_name}</span>
                  <span className="ml-2 text-muted">{t('rentAdmin.due')} {fmtDate(e.due_date)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span>{taka(e.received_paisa)} / {taka(e.amount_paisa)}</span>
                  {isCashier && remaining(e) > 0n && (
                    <button type="button" onClick={() => { setReceiving(e); setAmount(''); }} className="h-9 rounded-md border border-border px-3 text-xs hover:bg-hover">{t('rentAdmin.receive')}</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmSheet
        open={receiving !== null}
        onClose={() => setReceiving(null)}
        title={t('rentAdmin.receiveTitle')}
        confirmLabel={t('common.confirm')}
        canConfirm={parseAmountInput(amount) !== null}
        onConfirm={receive}
      >
        {receiving && <p className="text-muted">{receiving.stream_name} · {receiving.period} · {t('rentAdmin.remaining')} {taka(remaining(receiving))}</p>}
        <label className="block text-sm text-muted">
          {t('common.amount')}
          <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="block text-sm text-muted">
          {t('payment.method')}
          <select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`payment.methods.${m}`)}</option>)}
          </select>
        </label>
        <label className="block text-sm text-muted">
          {t('common.date')}
          <input type="date" className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </label>
      </ConfirmSheet>
    </div>
  );
}
