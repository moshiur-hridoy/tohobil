import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountSelect, type CashAccount } from '../../components/AccountSelect';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import {
  AdminHeader, AdminPage, BTN_PRIMARY, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, FieldLabel, ICONS, Segmented, SplitLayout, StatGrid, StatTile,
} from '../../components/admin';
import { Chip, Icon } from '../../components/ui';
import { formatCount } from '../../lib/format';
import { holdingTotals } from '../../lib/holding';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { taka, parseAmountInput } from '../../lib/money';
import type { AssetRow, NavResponse, PartnerRow } from '../../lib/types';

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

  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<{ items: PartnerRow[] }>('/partners') });
  const [chosenTab, setTab] = useState<'assets' | 'investments' | null>(null);
  const [looseShop, setLooseShop] = useState('');
  const navigate = useNavigate();
  const [partnerName, setPartnerName] = useState('');
  const [partnerKind, setPartnerKind] = useState<AssetRow['kind']>('gold');

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

  const addPartner = async () => {
    const created = await api<{ partner: PartnerRow }>('/partners', { method: 'POST', body: { kind: partnerKind, name: partnerName.trim() } });
    setPartnerName('');
    void qc.invalidateQueries({ queryKey: ['partners'] });
    void navigate(`/admin/assets/investment/${created.partner.id}`);
  };

  // Creates the shop and brings every gold purchase that has no shop under it, in one step.
  const claimLoose = async () => {
    const created = await api<{ partner: PartnerRow }>('/partners', { method: 'POST', body: { kind: 'gold', name: looseShop.trim() } });
    await api(`/partners/${created.partner.id}/adopt`, { method: 'POST' });
    setLooseShop('');
    refresh();
    void qc.invalidateQueries({ queryKey: ['partners'] });
    void navigate(`/admin/assets/investment/${created.partner.id}`);
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

  const all = assets.data?.items ?? [];
  // Gold is bought again and again: all of it is one card that opens the gold page. Land and houses stay one card each.
  // An asset bought through a shop belongs on that shop's page (Investments); the rest are the fund's own assets.
  // Gold is always an investment, never one of the fund's own assets: gold not yet under a shop waits
  // on the Investments tab for one.
  const items = all.filter((a) => !a.partner_id && a.kind !== 'gold');
  const looseGold = all.filter((a) => !a.partner_id && a.kind === 'gold' && a.status !== 'planned');
  const tab = chosenTab ?? (items.length === 0 ? 'investments' : 'assets');
  const partnerList = partners.data?.items ?? [];
  const STATUS_TONE: Record<AssetRow['status'], string> = {
    planned: 'bg-soft text-ink2',
    acquiring: 'bg-warn-bg text-warn',
    held: 'bg-ok-bg text-ok',
    sold: 'bg-soft text-muted',
  };
  const KIND_TONE: Record<AssetRow['kind'], string> = {
    gold: 'bg-warn-bg text-warn',
    land: 'bg-ok-bg text-ok',
    house: 'bg-blue-bg text-blue',
    other: 'bg-soft text-ink2',
  };

  const addForm = isCashier && (
    <Card className="p-5">
      <CardHead icon={ICONS.plus} title={t('adminUi.assets.addTitle')} sub={t('assetsAdmin.ideaHint')} />
      <div className="space-y-3">
        <FieldLabel label={t('assetsAdmin.kind')}>
          <select className="field w-full" value={newKind} onChange={(e) => setNewKind(e.target.value as AssetRow['kind'])}>
            {(['gold', 'land', 'house', 'other'] as const).map((k) => <option key={k} value={k}>{t(`assets.${k}`)}</option>)}
          </select>
        </FieldLabel>
        <FieldLabel label={t('assetsAdmin.name')}>
          <input className="field w-full" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </FieldLabel>
        <button type="button" disabled={newName.trim().length === 0} onClick={() => void addIdea()} className={`${BTN_PRIMARY} w-full`}>
          {t('assetsAdmin.addIdea')}
        </button>
      </div>
    </Card>
  );

  const partnerForm = isCashier && (
    <Card className="p-5">
      <CardHead icon={ICONS.plus} title={t('assetsAdmin.addPartnerTitle')} sub={t('assetsAdmin.partnerHint')} />
      <div className="space-y-3">
        <FieldLabel label={t('assetsAdmin.kind')}>
          <select className="field w-full" value={partnerKind} onChange={(e) => setPartnerKind(e.target.value as AssetRow['kind'])}>
            {(['gold', 'land', 'house', 'other'] as const).map((k) => <option key={k} value={k}>{t(`assets.${k}`)}</option>)}
          </select>
        </FieldLabel>
        <FieldLabel label={t('assetsAdmin.partnerName')}>
          <input className="field w-full" value={partnerName} onChange={(e) => setPartnerName(e.target.value)} />
        </FieldLabel>
        <button type="button" disabled={partnerName.trim().length === 0} onClick={() => void addPartner()} className={`${BTN_PRIMARY} w-full`}>
          {t('assetsAdmin.addPartner')}
        </button>
      </div>
    </Card>
  );

  const looseTotals = holdingTotals(looseGold);
  const partnerCards = (
    <ul className="grid gap-3.5 md:grid-cols-2">
      {looseGold.length > 0 && (
        // Gold bought before shops were recorded: one investment card that only needs the shop's name.
        <li className="flex flex-col rounded-[18px] border border-warn bg-card p-[18px] shadow-card" data-testid="partner-row">
          <div className="flex items-start gap-3">
            <Chip tone={KIND_TONE.gold} d={ICONS.layers} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{t('assets.gold')}</p>
              <p className="text-xs text-muted">{t('assetsAdmin.noShopYet')} · {t('holding.subtitle', { n: formatCount(looseTotals.count) })}</p>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl bg-soft px-3 py-2">
              <dt className="text-xs text-muted">{t('holding.invested')}</dt>
              <dd className="font-bold tabular-nums">{taka(looseTotals.invested)}</dd>
            </div>
            <div className="rounded-xl bg-soft px-3 py-2">
              <dt className="text-xs text-muted">{t('holding.value')}</dt>
              <dd className="font-bold tabular-nums">{taka(looseTotals.value)}</dd>
            </div>
          </dl>
          {isCashier && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="mb-2 text-xs text-muted">{t('assetsAdmin.looseHint')}</p>
              <div className="flex flex-wrap gap-2">
                <input className="field min-w-0 flex-1" placeholder={t('assetsAdmin.partnerName')} value={looseShop} onChange={(e) => setLooseShop(e.target.value)} />
                <button type="button" disabled={looseShop.trim().length === 0} onClick={() => void claimLoose()} className={BTN_SM_PRIMARY}>{t('assetsAdmin.claimLoose')}</button>
              </div>
            </div>
          )}
        </li>
      )}
      {partnerList.map((p) => {
        const mine = holdingTotals(all.filter((a) => a.partner_id === p.id));
        return (
          <li key={p.id}>
            <Link to={`/admin/assets/investment/${p.id}`} className="flex h-full flex-col rounded-[18px] border border-border bg-card p-[18px] shadow-card outline-none transition hover:border-input hover:shadow-lift focus-visible:ring-2 focus-visible:ring-ring" data-testid="partner-row">
              <div className="flex items-start gap-3">
                <Chip tone={KIND_TONE[p.kind]} d={p.kind === 'gold' ? ICONS.layers : p.kind === 'other' ? ICONS.doc : ICONS.home} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{p.name}</p>
                  <p className="text-xs text-muted">{t(`assets.${p.kind}`)} · {t('holding.subtitle', { n: formatCount(mine.count) })}</p>
                </div>
                <span className="shrink-0 text-muted"><Icon d={ICONS.chevron} size={18} /></span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2.5">
                <div className="rounded-xl bg-soft px-3 py-2">
                  <dt className="text-xs text-muted">{t('holding.invested')}</dt>
                  <dd className="font-bold tabular-nums">{taka(mine.invested)}</dd>
                </div>
                <div className="rounded-xl bg-soft px-3 py-2">
                  <dt className="text-xs text-muted">{t('holding.value')}</dt>
                  <dd className="font-bold tabular-nums">{taka(mine.value)}</dd>
                </div>
              </dl>
              <p className={`mt-3 border-t border-border pt-3 text-sm font-semibold ${mine.profit > 0n ? 'text-ok' : mine.profit < 0n ? 'text-bad' : 'text-muted'}`}>
                {t('holding.profit')}: {mine.profit > 0n ? '+' : mine.profit < 0n ? '−' : ''}{taka(mine.profit < 0n ? -mine.profit : mine.profit)}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <AdminPage>
      <AdminHeader title={t('assetsAdmin.title')} subtitle={t('adminUi.sub.assets')} />

      <StatGrid>
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.trend} label={t('assetsAdmin.netAssets')} value={nav.data ? taka(nav.data.net_assets_paisa) : null} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.layers} label={t('assetsAdmin.navPerShare')} value={nav.data ? taka(nav.data.nav_per_share_paisa) : null} />
        <StatTile tone="bg-soft text-ink2" icon={ICONS.users} label={t('assetsAdmin.shares')} value={nav.data ? formatCount(Number(nav.data.shares_outstanding)) : null} />
        {/* What the fund has put into shops, with how many shops and own assets; the old single "assets" count hid the investment. */}
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.wallet} label={t('assetsAdmin.statInvested')}
          value={assets.data ? taka(holdingTotals(all.filter((a) => a.partner_id || a.kind === 'gold')).invested) : null}
          sub={nav.data && nav.data.stale_valuations.length > 0
            ? t('adminUi.assets.staleValuations', { n: formatCount(nav.data.stale_valuations.length) })
            : t('assetsAdmin.statInvestedSub', { shops: formatCount(partnerList.length + (looseGold.length > 0 ? 1 : 0)), assets: formatCount(items.length) })}
          />
      </StatGrid>
      {nav.error && <LoadError error={nav.error} onRetry={() => void nav.refetch()} />}

      <Segmented
        label={t('assetsAdmin.title')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'assets', label: t('assetsAdmin.tabAssets'), count: formatCount(items.length) },
          { value: 'investments', label: t('assetsAdmin.tabInvestments'), count: formatCount(partnerList.length + (looseGold.length > 0 ? 1 : 0)) },
        ]}
      />

      <SplitLayout
        sideWidth="340px"
        main={
          tab === 'investments' ? (
            <div className="space-y-3.5">
            {partners.error ? <LoadError error={partners.error} onRetry={() => void partners.refetch()} />
            : !partners.data ? <ListSkeleton rows={3} />
            : partnerList.length === 0 && looseGold.length === 0 ? <Card className="p-5"><EmptyCard text={t('assetsAdmin.noPartners')} icon={ICONS.home} /></Card>
            : partnerCards}
            </div>
          ) : assets.error ? (
            <LoadError error={assets.error} onRetry={() => void assets.refetch()} />
          ) : !assets.data ? (
            <ListSkeleton rows={4} />
          ) : items.length === 0 ? (
            <Card className="p-5"><EmptyCard text={t('common.noData')} icon={ICONS.home} /></Card>
          ) : (
            <ul className="grid gap-3.5 md:grid-cols-2">
              {items.map((a) => (
                <li key={a.id} className="flex flex-col rounded-[18px] border border-border bg-card p-[18px] shadow-card" data-testid="asset-row">
                  <div className="flex items-start gap-3">
                    <Chip tone={KIND_TONE[a.kind]} d={a.kind === 'gold' ? ICONS.layers : a.kind === 'other' ? ICONS.doc : ICONS.home} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{a.name}</p>
                      <p className="text-xs text-muted">{t(`assets.${a.kind}`)}{a.location ? ` · ${a.location}` : ''}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[a.status]}`}>{t(`assetsAdmin.status.${a.status}`)}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2.5">
                    <div className="rounded-xl bg-soft px-3 py-2">
                      <dt className="text-xs text-muted">{t('assetsAdmin.paid')}</dt>
                      <dd className="font-bold tabular-nums">{taka(a.cost_paisa)}</dd>
                    </div>
                    <div className="rounded-xl bg-soft px-3 py-2">
                      <dt className="text-xs text-muted">{t('assetsAdmin.valued')}</dt>
                      <dd className="font-bold tabular-nums">{a.latest_value_paisa ? taka(a.latest_value_paisa) : '—'}</dd>
                    </div>
                  </dl>
                  {isCashier && a.status === 'acquiring' && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      <button type="button" onClick={() => setAction({ kind: 'pay', asset: a })} className={BTN_SM_PRIMARY}>{t('assetsAdmin.payInstalment')}</button>
                      <button type="button" onClick={() => setAction({ kind: 'document', asset: a })} className={BTN_SM}>{t('assetsAdmin.attachDocument')}</button>
                      <button type="button" onClick={() => setAction({ kind: 'complete', asset: a })} className={BTN_SM}>{t('assetsAdmin.complete')}</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )
        }
        side={(tab === 'investments' ? partnerForm : addForm) || null}
      />

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
              <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <AccountSelect value={account} onChange={setAccount} />
          </>
        )}
        {(action?.kind === 'pay' || action?.kind === 'complete') && (
          <label className="block text-sm text-muted">
            {t('assetsAdmin.note')}
            <textarea className="field mt-1 min-h-20 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        )}
        {action?.kind === 'complete' && <p className="text-sm text-muted">{t('assetsAdmin.completeHint')}</p>}
        {action?.kind === 'document' && (
          <>
            <label className="block text-sm text-muted">
              {t('assetsAdmin.docType')}
              <select className="field mt-1 w-full" value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="deed">{t('assetsAdmin.docDeed')}</option>
                <option value="receipt">{t('assetsAdmin.docReceipt')}</option>
                <option value="other">{t('assetsAdmin.docOther')}</option>
              </select>
            </label>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </>
        )}
      </ConfirmSheet>
    </AdminPage>
  );
}
