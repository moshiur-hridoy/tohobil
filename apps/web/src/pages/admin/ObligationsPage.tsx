import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountSelect, type CashAccount } from '../../components/AccountSelect';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { AdminHeader, AdminPage, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, ICONS, StatGrid, StatTile } from '../../components/admin';
import { formatCount } from '../../lib/format';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtPeriod } from '../../lib/dates';
import { parseAmountInput, taka } from '../../lib/money';

interface Levy {
  held_paisa: string;
  remittances: Array<{ seq: string; entry_date: string; amount_paisa: string; memo: string }>;
  levies: Array<{ period: string; members: number; total_paisa: string; outstanding_paisa: string }>;
}

interface Special {
  items: Array<{
    period: string;
    due_date: string;
    reason: string | null;
    total_paisa: string;
    outstanding_paisa: string;
    members: Array<{ code: string; full_name: string; shares: number; amount_paisa: string; outstanding_paisa: string; status: string }>;
  }>;
}

interface Financing {
  id: string;
  asset_name: string;
  counterparty: string;
  description: string;
  total_paisa: string;
  instalments: Array<{ id: string; due_on: string; amount_paisa: string; paid_at: string | null }>;
}

/** Cashier: special contributions (who has paid), levy money held for the registrar, and the instalments of deferred purchases (spec 18.7). */
export function ObligationsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [remit, setRemit] = useState(false);
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<CashAccount>('CASH');
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [paying, setPaying] = useState<{ id: string; label: string } | null>(null);
  const [payAccount, setPayAccount] = useState<CashAccount>('BANK');

  const levy = useQuery({ queryKey: ['levy'], queryFn: () => api<Levy>('/levy') });
  const special = useQuery({ queryKey: ['special-contributions'], queryFn: () => api<Special>('/special-contributions') });
  const financing = useQuery({ queryKey: ['financing'], queryFn: () => api<{ items: Financing[] }>('/financing') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['levy'] });
    void qc.invalidateQueries({ queryKey: ['special-contributions'] });
    void qc.invalidateQueries({ queryKey: ['financing'] });
    void qc.invalidateQueries({ queryKey: ['nav'] });
  };

  const levyOutstanding = levy.data?.levies.reduce((n, l) => n + BigInt(l.outstanding_paisa), 0n) ?? 0n;
  const unpaid = financing.data?.items.flatMap((f) => f.instalments.filter((i) => !i.paid_at).map((i) => ({ ...i, asset: f.asset_name }))) ?? [];
  const next = [...unpaid].sort((x, y) => x.due_on.localeCompare(y.due_on))[0];

  return (
    <AdminPage>
      <AdminHeader title={t('obligations.title')} subtitle={t('adminUi.sub.obligations')} />

      <StatGrid>
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.shield} label={t('adminUi.obligations.statLevyHeld')} value={levy.data ? taka(levy.data.held_paisa) : null} />
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.clock} label={t('adminUi.obligations.statLevyOutstanding')} value={levy.data ? taka(levyOutstanding) : null} />
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.layers} label={t('adminUi.obligations.statInstalments')} value={financing.data ? formatCount(unpaid.length) : null}
          sub={financing.data && unpaid.length > 0 ? taka(unpaid.reduce((n, i) => n + BigInt(i.amount_paisa), 0n)) : undefined} />
        <StatTile tone="bg-bad-bg text-bad" icon={ICONS.alert} label={t('adminUi.obligations.statNext')}
          value={financing.data ? (next ? fmtDate(next.due_on) : '—') : null}
          sub={next ? `${next.asset} · ${taka(next.amount_paisa)}` : undefined} />
      </StatGrid>

      {(special.error || (special.data && special.data.items.length > 0)) && (
        <Card className="px-5 pb-3 pt-5 sm:px-6">
          <CardHead icon={ICONS.layers} tone="bg-primary-soft text-primary" title={t('obligations.special')} sub={t('obligations.specialHint')} />
          {special.error ? (
            <LoadError error={special.error} onRetry={() => void special.refetch()} />
          ) : (
            <div className="space-y-4 pb-2">
              {special.data!.items.map((s) => {
                const paid = s.members.filter((m) => BigInt(m.outstanding_paisa) <= 0n).length;
                return (
                  <div key={s.period} className="rounded-xl border border-border p-3.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-semibold">{fmtPeriod(s.period)} · <span className="font-normal text-muted">{fmtDate(s.due_date)}</span></p>
                      <p className="tabular-nums">
                        <span className={BigInt(s.outstanding_paisa) > 0n ? 'font-semibold text-warn' : 'text-muted'}>{taka(s.outstanding_paisa)}</span>
                        <span className="text-muted"> / {taka(s.total_paisa)} {t('obligations.outstanding')}</span>
                      </p>
                    </div>
                    {s.reason && <p className="mt-0.5 text-sm text-muted">{s.reason}</p>}
                    <p className="mt-1 text-xs text-muted">{t('obligations.specialPaidOf', { paid: formatCount(paid), count: s.members.length })}</p>
                    <ul className="mt-2 text-sm">
                      {s.members.map((m) => (
                        <li key={m.code} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 first:border-t-0">
                          <span className="min-w-0 truncate"><span className="font-medium">{m.code}</span> · {m.full_name}</span>
                          <span className="flex items-center gap-2 tabular-nums">
                            <b>{taka(BigInt(m.outstanding_paisa) > 0n ? m.outstanding_paisa : m.amount_paisa)}</b>
                            <StatusPill status={m.status} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card className="px-5 pb-3 pt-5 sm:px-6">
          <CardHead
            icon={ICONS.shield}
            tone="bg-blue-bg text-blue"
            title={t('obligations.levy')}
            sub={t('obligations.levyHint')}
            action={isCashier && levy.data && BigInt(levy.data.held_paisa) > 0n ? (
              <button type="button" onClick={() => setRemit(true)} className={BTN_SM_PRIMARY}>{t('obligations.remit')}</button>
            ) : undefined}
          />
          {levy.error ? (
            <LoadError error={levy.error} onRetry={() => void levy.refetch()} />
          ) : !levy.data ? (
            <ListSkeleton rows={2} />
          ) : levy.data.levies.length === 0 ? (
            <EmptyCard text={t('obligations.noLevy')} />
          ) : (
            <ul>
              {levy.data.levies.map((l) => (
                <li key={l.period} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2.5 text-sm last:border-b-0">
                  <span>
                    <span className="font-semibold">{fmtPeriod(l.period)}</span>
                    <span className="ml-2 text-muted">{t('obligations.members', { count: l.members })}</span>
                  </span>
                  <span className="tabular-nums">
                    <span className={BigInt(l.outstanding_paisa) > 0n ? 'font-semibold text-warn' : 'text-muted'}>{taka(l.outstanding_paisa)}</span>
                    <span className="text-muted"> / {taka(l.total_paisa)} {t('obligations.outstanding')}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {levy.data && levy.data.remittances.length > 0 && (
            <>
              <p className="mb-1 mt-4 text-xs font-semibold text-muted">{t('adminUi.obligations.remittances')}</p>
              <ul className="text-sm">
                {levy.data.remittances.map((r) => (
                  <li key={r.seq} className="flex justify-between gap-2 border-t border-border py-2">
                    <span className="min-w-0 truncate"><span className="text-muted">{fmtDate(r.entry_date)}</span> · {r.memo}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{taka(r.amount_paisa)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card className="px-5 pb-3 pt-5 sm:px-6">
          <CardHead icon={ICONS.home} title={t('obligations.financing')} sub={t('obligations.financingHint')} />
          {financing.error ? (
            <LoadError error={financing.error} onRetry={() => void financing.refetch()} />
          ) : !financing.data ? (
            <ListSkeleton rows={2} />
          ) : financing.data.items.length === 0 ? (
            <EmptyCard text={t('obligations.noFinancing')} />
          ) : (
            <div className="space-y-4 pb-2">
              {financing.data.items.map((f) => {
                const paid = f.instalments.filter((i) => i.paid_at).length;
                return (
                  <div key={f.id} className="rounded-xl border border-border p-3.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-semibold">{f.asset_name}</p>
                      <p className="font-bold tabular-nums">{taka(f.total_paisa)}</p>
                    </div>
                    <p className="text-xs text-muted">{f.counterparty} · {formatCount(paid)}/{formatCount(f.instalments.length)}</p>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-soft">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${f.instalments.length ? Math.round((paid * 100) / f.instalments.length) : 0}%` }} />
                    </div>
                    <ul className="mt-2 text-sm">
                      {f.instalments.map((i) => (
                        <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 first:border-t-0">
                          <span className="tabular-nums">{fmtDate(i.due_on)} · <b>{taka(i.amount_paisa)}</b></span>
                          {i.paid_at ? (
                            <StatusPill status="paid" label={t('obligations.paid')} />
                          ) : (
                            isCashier && (
                              <button type="button" onClick={() => setPaying({ id: i.id, label: `${fmtDate(i.due_on)} · ${taka(i.amount_paisa)}` })} className={BTN_SM}>{t('obligations.payInstalment')}</button>
                            )
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <ConfirmSheet
        open={remit}
        onClose={() => setRemit(false)}
        title={t('obligations.remit')}
        confirmLabel={t('common.confirm')}
        canConfirm={parseAmountInput(amount) !== null && payee.trim().length > 0 && note.trim().length >= 3}
        onConfirm={async () => {
          await api('/levy/remittances', { method: 'POST', body: { amount_paisa: parseAmountInput(amount), account, payee: payee.trim(), note: note.trim() } });
          setAmount('');
          setPayee('');
          setNote('');
          refresh();
        }}
      >
        <label className="block text-sm text-muted">{t('common.amount')}
          <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <AccountSelect value={account} onChange={setAccount} />
        <label className="block text-sm text-muted">{t('obligations.payee')}
          <input className="field mt-1 w-full" value={payee} onChange={(e) => setPayee(e.target.value)} />
        </label>
        <label className="block text-sm text-muted">{t('assetsAdmin.note')}
          <textarea className="field mt-1 min-h-16 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </ConfirmSheet>

      <ConfirmSheet
        open={paying !== null}
        onClose={() => setPaying(null)}
        title={t('obligations.payInstalment')}
        confirmLabel={t('common.confirm')}
        onConfirm={async () => {
          if (!paying) return;
          await api(`/financing/instalments/${paying.id}/pay`, { method: 'POST', body: { account: payAccount } });
          refresh();
        }}
      >
        {paying && <p className="text-muted">{paying.label}</p>}
        <AccountSelect value={payAccount} onChange={setPayAccount} />
      </ConfirmSheet>
    </AdminPage>
  );
}
