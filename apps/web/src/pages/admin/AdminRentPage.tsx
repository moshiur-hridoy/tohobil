import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, type PaymentMethod } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import {
  AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, FieldLabel, ICONS, SplitLayout, StatGrid, StatTile,
} from '../../components/admin';
import { Icon, DateInput } from '../../components/ui';
import { formatCount } from '../../lib/format';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtPeriod, todayDhaka } from '../../lib/dates';
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

  const items = expected.data?.items ?? [];
  const totalExpected = items.reduce((n, e) => n + BigInt(e.amount_paisa), 0n);
  const totalReceived = items.reduce((n, e) => n + BigInt(e.received_paisa), 0n);
  const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 100n) / whole) : 0);

  return (
    <AdminPage>
      <AdminHeader
        title={t('rentAdmin.title')}
        subtitle={t('adminUi.sub.rent')}
        actions={
          <>
            <input type="month" aria-label={t('rentAdmin.period')} className="field w-[10.5rem]" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
            {isCashier && (
              <button type="button" onClick={() => void generate()} className={BTN_SECONDARY}>
                <Icon d={ICONS.plus} size={18} />
                {t('rentAdmin.generate')}
              </button>
            )}
          </>
        }
      />

      <StatGrid>
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.home} label={t('adminUi.rent.statExpected')} value={expected.data ? taka(totalExpected) : null} sub={fmtPeriod(period)} />
        <StatTile tone="bg-ok-bg text-ok" icon={ICONS.check} label={t('adminUi.rent.statReceived')} value={expected.data ? taka(totalReceived) : null}
          sub={expected.data && totalExpected > 0n ? `${formatCount(pct(totalReceived, totalExpected))}%` : undefined} />
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.clock} label={t('adminUi.rent.statRemaining')} value={expected.data ? taka(totalExpected - totalReceived) : null}
          valueClass={totalExpected - totalReceived > 0n ? 'text-warn' : ''} />
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.layers} label={t('adminUi.rent.statStreams')} value={streams.data ? formatCount(streams.data.items.length) : null} />
      </StatGrid>

      <SplitLayout
        main={
          <Card className="px-5 pb-3 pt-5 sm:px-6">
            <CardHead title={t('rentAdmin.expected')} sub={fmtPeriod(period)} />
            {expected.error ? (
              <LoadError error={expected.error} onRetry={() => void expected.refetch()} />
            ) : !expected.data ? (
              <ListSkeleton rows={2} />
            ) : items.length === 0 ? (
              <EmptyCard text={t('rentAdmin.noExpected')} icon={ICONS.home} />
            ) : (
              <ul>
                {items.map((e) => {
                  const left = remaining(e);
                  const p = Math.min(pct(BigInt(e.received_paisa), BigInt(e.amount_paisa)), 100);
                  return (
                    <li key={e.id} className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-b-0" data-testid="rent-expected">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{e.stream_name}</p>
                        <p className="text-xs text-muted">
                          {e.tenant_name ? `${e.tenant_name} · ` : ''}{t('rentAdmin.due')} {fmtDate(e.due_date)}
                        </p>
                      </div>
                      <div className="w-40 min-w-0">
                        <p className="text-right text-[0.8125rem] tabular-nums"><b>{taka(e.received_paisa)}</b> <span className="text-muted">/ {taka(e.amount_paisa)}</span></p>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
                          <div className={`h-full rounded-full ${left > 0n ? 'bg-warn' : 'bg-primary'}`} style={{ width: `${p}%` }} />
                        </div>
                      </div>
                      <div className="w-24 text-right">
                        {isCashier && left > 0n ? (
                          <button type="button" onClick={() => { setReceiving(e); setAmount(''); }} className={BTN_SM_PRIMARY}>{t('rentAdmin.receive')}</button>
                        ) : (
                          <StatusPill status={left > 0n ? 'unpaid' : 'paid'} />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        }
        side={
          <>
            <Card className="px-5 pb-3 pt-5">
              <CardHead icon={ICONS.home} tone="bg-blue-bg text-blue" title={t('rentAdmin.streams')} />
              {streams.error ? (
                <LoadError error={streams.error} onRetry={() => void streams.refetch()} />
              ) : !streams.data ? (
                <ListSkeleton rows={2} />
              ) : streams.data.items.length === 0 ? (
                <p className="py-3 text-sm text-muted">{t('rentAdmin.noStreams')}</p>
              ) : (
                <ul>
                  {streams.data.items.map((st) => (
                    <li key={st.id} className="border-t border-border py-2.5 first:border-t-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-semibold">{st.name}</span>
                        <span className="shrink-0 font-bold tabular-nums">{taka(st.monthly_amount_paisa)}</span>
                      </div>
                      <p className="text-xs text-muted">
                        {[st.tenant_name, st.asset_name, t('rentAdmin.dueDay', { day: st.due_day })].filter(Boolean).join(' · ')}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {isCashier && (
              <Card className="p-5">
                <CardHead icon={ICONS.plus} title={t('adminUi.rent.addTitle')} />
                <div className="space-y-3">
                  <FieldLabel label={t('rentAdmin.name')}><input className="field w-full" value={name} onChange={(e) => setName(e.target.value)} /></FieldLabel>
                  <FieldLabel label={t('rentAdmin.tenant')}><input className="field w-full" value={tenant} onChange={(e) => setTenant(e.target.value)} /></FieldLabel>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldLabel label={t('rentAdmin.monthly')}><input inputMode="decimal" className="field w-full" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></FieldLabel>
                    <FieldLabel label={t('rentAdmin.dueDayLabel')}><input type="number" min={1} max={28} className="field w-full" value={dueDay} onChange={(e) => setDueDay(e.target.value)} /></FieldLabel>
                  </div>
                  <FieldLabel label={t('rentAdmin.activeFrom')}><DateInput className="field w-full" value={from} onChange={(e) => setFrom(e.target.value)} /></FieldLabel>
                  <button type="button" disabled={!name.trim() || parseAmountInput(monthly) === null} onClick={() => void addStream()} className={`${BTN_PRIMARY} w-full`}>
                    {t('rentAdmin.addStream')}
                  </button>
                </div>
              </Card>
            )}
          </>
        }
      />

      <ConfirmSheet
        open={receiving !== null}
        onClose={() => setReceiving(null)}
        title={t('rentAdmin.receiveTitle')}
        confirmLabel={t('common.confirm')}
        canConfirm={parseAmountInput(amount) !== null}
        onConfirm={receive}
      >
        {receiving && <p className="text-muted">{receiving.stream_name} · {receiving.period} · {t('rentAdmin.remaining')} {taka(remaining(receiving))}</p>}
        <label className="field-label">
          {t('common.amount')}
          <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field-label">
          {t('payment.method')}
          <select className="field mt-1 w-full" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`payment.methods.${m}`)}</option>)}
          </select>
        </label>
        <label className="field-label">
          {t('common.date')}
          <DateInput className="field mt-1 w-full" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </label>
      </ConfirmSheet>
    </AdminPage>
  );
}
