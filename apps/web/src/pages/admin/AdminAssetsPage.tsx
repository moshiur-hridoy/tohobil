import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountSelect, type CashAccount } from '../../components/AccountSelect';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { taka, parseAmountInput } from '../../lib/money';
import type { AssetRow, NavResponse } from '../../lib/types';

type Action = { kind: 'pay' | 'complete' | 'document'; asset: AssetRow } | null;

/** Cashier: the fund's assets, staged payments on land or a house, and marking an acquisition complete. */
export function AdminAssetsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [action, setAction] = useState<Action>(null);
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<CashAccount>('BANK');
  const [note, setNote] = useState('');
  const [docType, setDocType] = useState('deed');
  const [file, setFile] = useState<File | null>(null);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AssetRow['kind']>('land');

  const assets = useQuery({ queryKey: ['assets-admin'], queryFn: () => api<{ items: AssetRow[] }>('/assets?limit=100') });
  const nav = useQuery({ queryKey: ['nav'], queryFn: () => api<NavResponse>('/nav') });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['assets-admin'] });
    void qc.invalidateQueries({ queryKey: ['nav'] });
  };
  const close = () => {
    setAction(null);
    setAmount('');
    setNote('');
    setFile(null);
  };

  const addIdea = async () => {
    await api('/assets', { method: 'POST', body: { kind: newKind, name: newName.trim() } });
    setNewName('');
    refresh();
  };

  const confirm = async () => {
    if (!action) return;
    const id = action.asset.id;
    if (action.kind === 'pay') {
      await api(`/assets/${id}/payments`, { method: 'POST', body: { amount_paisa: parseAmountInput(amount), account, note: note.trim() } });
    } else if (action.kind === 'complete') {
      await api(`/assets/${id}/complete`, { method: 'POST', body: { note: note.trim() } });
    } else if (file) {
      const form = new FormData();
      form.append('file', file);
      const up = await api<{ id: string }>('/files', { method: 'POST', body: form });
      await api(`/assets/${id}/documents`, { method: 'POST', body: { file_id: up.id, doc_type: docType } });
    }
    refresh();
  };

  const canConfirm =
    action?.kind === 'pay' ? parseAmountInput(amount) !== null && note.trim().length >= 3
    : action?.kind === 'complete' ? note.trim().length >= 3
    : file !== null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('assetsAdmin.title')}</h1>

      {nav.data && (
        <section className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-4 text-sm lg:grid-cols-3">
          <div><div className="text-muted">{t('assetsAdmin.netAssets')}</div><div className="text-lg font-semibold">{taka(nav.data.net_assets_paisa)}</div></div>
          <div><div className="text-muted">{t('assetsAdmin.navPerShare')}</div><div className="text-lg font-semibold">{taka(nav.data.nav_per_share_paisa)}</div></div>
          <div><div className="text-muted">{t('assetsAdmin.shares')}</div><div className="text-lg font-semibold">{nav.data.shares_outstanding}</div></div>
        </section>
      )}

      {isCashier && (
        <section className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
          <label className="text-sm text-muted">
            {t('assetsAdmin.kind')}
            <select className="mt-1 block h-11 rounded-md border border-input bg-background px-2" value={newKind} onChange={(e) => setNewKind(e.target.value as AssetRow['kind'])}>
              {(['gold', 'land', 'house', 'other'] as const).map((k) => <option key={k} value={k}>{t(`assets.${k}`)}</option>)}
            </select>
          </label>
          <label className="flex-1 text-sm text-muted">
            {t('assetsAdmin.name')}
            <input className="mt-1 block h-11 w-full rounded-md border border-input bg-background px-2" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <button type="button" disabled={newName.trim().length === 0} onClick={() => void addIdea()} className="h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50">
            {t('assetsAdmin.addIdea')}
          </button>
          <p className="basis-full text-xs text-muted">{t('assetsAdmin.ideaHint')}</p>
        </section>
      )}

      {assets.error ? (
        <LoadError error={assets.error} onRetry={() => void assets.refetch()} />
      ) : !assets.data ? (
        <ListSkeleton rows={4} />
      ) : assets.data.items.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <ul className="space-y-3">
          {assets.data.items.map((a) => (
            <li key={a.id} className="rounded-lg border border-border bg-card p-4" data-testid="asset-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">{a.name}</span>
                  <span className="ml-2 text-sm text-muted">{t(`assets.${a.kind}`)} · {t(`assetsAdmin.status.${a.status}`)}</span>
                </div>
                <div className="text-right text-sm">
                  <div>{t('assetsAdmin.paid')}: {taka(a.cost_paisa)}</div>
                  {a.latest_value_paisa && <div className="text-muted">{t('assetsAdmin.valued')}: {taka(a.latest_value_paisa)}</div>}
                </div>
              </div>
              {isCashier && a.status === 'acquiring' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setAction({ kind: 'pay', asset: a })} className="h-9 rounded-md border border-border px-3 text-sm hover:bg-hover">{t('assetsAdmin.payInstalment')}</button>
                  <button type="button" onClick={() => setAction({ kind: 'document', asset: a })} className="h-9 rounded-md border border-border px-3 text-sm hover:bg-hover">{t('assetsAdmin.attachDocument')}</button>
                  <button type="button" onClick={() => setAction({ kind: 'complete', asset: a })} className="h-9 rounded-md border border-border px-3 text-sm hover:bg-hover">{t('assetsAdmin.complete')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmSheet
        open={action !== null}
        onClose={close}
        title={action ? t(`assetsAdmin.sheet.${action.kind}`) : ''}
        confirmLabel={t('common.confirm')}
        canConfirm={canConfirm}
        onConfirm={confirm}
      >
        {action && <p className="text-muted">{action.asset.name}</p>}
        {action?.kind === 'pay' && (
          <>
            <label className="block text-sm text-muted">
              {t('common.amount')}
              <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <AccountSelect value={account} onChange={setAccount} />
          </>
        )}
        {(action?.kind === 'pay' || action?.kind === 'complete') && (
          <label className="block text-sm text-muted">
            {t('assetsAdmin.note')}
            <textarea className="mt-1 min-h-20 w-full rounded-md border border-input bg-background p-2" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
        {action?.kind === 'complete' && <p className="text-sm text-muted">{t('assetsAdmin.completeHint')}</p>}
        {action?.kind === 'document' && (
          <>
            <label className="block text-sm text-muted">
              {t('assetsAdmin.docType')}
              <select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="deed">{t('assetsAdmin.docDeed')}</option>
                <option value="receipt">{t('assetsAdmin.docReceipt')}</option>
                <option value="other">{t('assetsAdmin.docOther')}</option>
              </select>
            </label>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </>
        )}
      </ConfirmSheet>
    </div>
  );
}
