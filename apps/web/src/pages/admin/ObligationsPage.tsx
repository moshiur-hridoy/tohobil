import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountSelect, type CashAccount } from '../../components/AccountSelect';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { parseAmountInput, taka } from '../../lib/money';

interface Levy {
  held_paisa: string;
  remittances: Array<{ seq: string; entry_date: string; amount_paisa: string; memo: string }>;
  levies: Array<{ period: string; members: number; total_paisa: string; outstanding_paisa: string }>;
}

interface Financing {
  id: string;
  asset_name: string;
  counterparty: string;
  description: string;
  total_paisa: string;
  instalments: Array<{ id: string; due_on: string; amount_paisa: string; paid_at: string | null }>;
}

/** Cashier: levy money held for the registrar, and the instalments of deferred purchases (spec 18.7). */
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
  const financing = useQuery({ queryKey: ['financing'], queryFn: () => api<{ items: Financing[] }>('/financing') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['levy'] });
    void qc.invalidateQueries({ queryKey: ['financing'] });
    void qc.invalidateQueries({ queryKey: ['nav'] });
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">{t('obligations.title')}</h1>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t('obligations.levy')}</h2>
            <p className="text-sm text-muted">{t('obligations.levyHint')}</p>
          </div>
          {levy.data && (
            <div className="text-right">
              <div className="text-sm text-muted">{t('obligations.held')}</div>
              <div className="text-lg font-semibold">{taka(levy.data.held_paisa)}</div>
              {isCashier && BigInt(levy.data.held_paisa) > 0n && (
                <button type="button" onClick={() => setRemit(true)} className="mt-1 h-9 rounded-xl border border-border px-3 text-xs hover:bg-hover">{t('obligations.remit')}</button>
              )}
            </div>
          )}
        </div>
        {levy.error ? (
          <LoadError error={levy.error} onRetry={() => void levy.refetch()} />
        ) : !levy.data ? (
          <ListSkeleton rows={2} />
        ) : levy.data.levies.length === 0 ? (
          <Empty text={t('obligations.noLevy')} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {levy.data.levies.map((l) => (
              <li key={l.period} className="flex flex-wrap justify-between gap-2 py-2">
                <span>{l.period} · {t('obligations.members', { count: l.members })}</span>
                <span>{t('obligations.outstanding')} {taka(l.outstanding_paisa)} / {taka(l.total_paisa)}</span>
              </li>
            ))}
          </ul>
        )}
        {levy.data && levy.data.remittances.length > 0 && (
          <ul className="mt-3 divide-y divide-border text-sm text-muted">
            {levy.data.remittances.map((r) => (
              <li key={r.seq} className="flex justify-between gap-2 py-1"><span>{fmtDate(r.entry_date)} · {r.memo}</span><span>{taka(r.amount_paisa)}</span></li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <h2 className="mb-1 font-semibold">{t('obligations.financing')}</h2>
        <p className="mb-3 text-sm text-muted">{t('obligations.financingHint')}</p>
        {financing.error ? (
          <LoadError error={financing.error} onRetry={() => void financing.refetch()} />
        ) : !financing.data ? (
          <ListSkeleton rows={2} />
        ) : financing.data.items.length === 0 ? (
          <Empty text={t('obligations.noFinancing')} />
        ) : (
          financing.data.items.map((f) => (
            <div key={f.id} className="mb-4">
              <div className="font-medium">{f.asset_name} · {f.counterparty} · {taka(f.total_paisa)}</div>
              <ul className="divide-y divide-border text-sm">
                {f.instalments.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{fmtDate(i.due_on)} · {taka(i.amount_paisa)}</span>
                    {i.paid_at ? (
                      <span className="text-ok">{t('obligations.paid')}</span>
                    ) : (
                      isCashier && (
                        <button type="button" onClick={() => setPaying({ id: i.id, label: `${fmtDate(i.due_on)} · ${taka(i.amount_paisa)}` })} className="h-9 rounded-xl border border-border px-3 text-xs hover:bg-hover">{t('obligations.payInstalment')}</button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

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
          <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <AccountSelect value={account} onChange={setAccount} />
        <label className="block text-sm text-muted">{t('obligations.payee')}
          <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={payee} onChange={(e) => setPayee(e.target.value)} />
        </label>
        <label className="block text-sm text-muted">{t('assetsAdmin.note')}
          <textarea className="mt-1 min-h-16 w-full rounded-md border border-input bg-background p-2" value={note} onChange={(e) => setNote(e.target.value)} />
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
    </div>
  );
}
