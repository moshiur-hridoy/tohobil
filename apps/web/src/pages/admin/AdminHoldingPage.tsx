import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, BTN_SM, BTN_SM_PRIMARY, Card, ICONS, InfoRow, StatGrid, StatTile } from '../../components/admin';
import { Icon } from '../../components/ui';
import { api, apiBlob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { holdingTotals, splitByCost } from '../../lib/holding';
import { paisaToDecimal, parseAmountInput, taka } from '../../lib/money';
import { todayDhaka } from '../../lib/dates';
import type { AssetRow, HoldingDocument, HoldingEntry, HoldingResponse } from '../../lib/types';
import { CreateProposalForm } from './ProposalsPage';

type Action =
  | { kind: 'paper'; entry: HoldingEntry }
  | { kind: 'complete'; entry: HoldingEntry }
  | { kind: 'contract' }
  | { kind: 'cpaper' }
  | null;

/** Profit in green with a plus, loss in red with a minus. */
function Profit({ paisa, className = '' }: { paisa: bigint; className?: string }) {
  if (paisa === 0n) return <span className={`text-muted ${className}`}>{taka(0n)}</span>;
  return <span className={`${paisa > 0n ? 'text-ok' : 'text-bad'} ${className}`}>{paisa > 0n ? '+' : '−'}{taka(paisa > 0n ? paisa : -paisa)}</span>;
}

/**
 * One shop the fund invests with (for example a jeweller) as a ledger of its own: the contract, its
 * terms and papers, every purchase with its date, amount, paying account, remark and papers, the value
 * the shop last reported, and the profit or loss that follows.
 */
export function AdminHoldingPage() {
  const { id } = useParams();
  if (!id) return <Navigate to="/admin/assets" replace />;
  return <HoldingView id={id} />;
}

function HoldingView({ id }: { id: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [action, setAction] = useState<Action>(null);
  const [note, setNote] = useState('');
  const [docType, setDocType] = useState('receipt');
  const [file, setFile] = useState<File | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  const [total, setTotal] = useState('');
  const [asOf, setAsOf] = useState(todayDhaka());
  const [basis, setBasis] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [everything, setEverything] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');

  const q = useQuery({ queryKey: ['holding', id], queryFn: () => api<HoldingResponse>(`/partners/${id}`) });
  const kind = q.data?.partner.kind ?? 'gold';
  // Purchases of this kind that belong to no shop yet (gold brought in from the old sheet).
  const loose = useQuery({
    queryKey: ['assets-admin'],
    queryFn: () => api<{ items: AssetRow[] }>('/assets?limit=100'),
    select: (r) => r.items.filter((a) => !a.partner_id && a.kind === kind && a.status !== 'planned'),
  });
  const [terms, setTerms] = useState<Record<string, string>>({});
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['holding', id] });
    void qc.invalidateQueries({ queryKey: ['partners'] });
    void qc.invalidateQueries({ queryKey: ['assets-admin'] });
    void qc.invalidateQueries({ queryKey: ['nav'] });
  };
  const close = () => { setAction(null); setNote(''); setFile(null); };

  const openPaper = async (d: HoldingDocument) => {
    window.open(URL.createObjectURL(await apiBlob(`/files/${d.file_id}`)), '_blank', 'noopener');
  };

  const confirm = async () => {
    if (!action) return;
    if (action.kind === 'contract') {
      const num = (v: string | undefined) => (v && v.trim() !== '' ? Number(v) : null);
      await api(`/partners/${id}`, {
        method: 'PATCH',
        body: {
          name: (terms.name ?? '').trim(),
          contract_date: terms.contract_date ? terms.contract_date : null,
          rate_percent: num(terms.rate_percent),
          period_months: num(terms.period_months),
          sharing_policy: (terms.sharing_policy ?? '').trim() || null,
          contract_note: (terms.contract_note ?? '').trim() || null,
        },
      });
    } else if (action.kind === 'complete') {
      await api(`/assets/${action.entry.asset_id}/complete`, { method: 'POST', body: { note: note.trim() } });
    } else if (file) {
      const form = new FormData();
      form.append('file', file);
      const up = await api<{ id: string }>('/files', { method: 'POST', body: form });
      // A contract paper belongs to the shop; a receipt belongs to the purchase it is for.
      const path = action.kind === 'paper' ? `/assets/${action.entry.asset_id}/documents` : `/partners/${id}/documents`;
      await api(path, { method: 'POST', body: { file_id: up.id, doc_type: docType } });
    }
    refresh();
  };
  const adopt = async () => {
    await api(`/partners/${id}/adopt`, { method: 'POST' });
    void qc.invalidateQueries({ queryKey: ['assets-admin'] });
    refresh();
  };

  if (q.error) return <AdminPage><LoadError error={q.error} onRetry={() => void q.refetch()} /></AdminPage>;
  if (!q.data) return <AdminPage><ListSkeleton rows={6} /></AdminPage>;

  const { partner, assets, entries, documents, valuations, withdrawals } = q.data;
  const contractPapers = documents.filter((d) => d.entity_type === 'partner');
  const totals = holdingTotals(assets);
  const assetOf = new Map(assets.map((a) => [a.id, a]));
  const papersOf = (assetId: string) => documents.filter((d) => d.entity_type === 'asset' && d.entity_id === assetId);
  const shown = entries.filter((e) => !e.reversed);

  // One line per valuation date: the sum of what each purchase was valued at that day.
  const history = [...valuations.reduce((m, v) => m.set(v.as_of, { total: (m.get(v.as_of)?.total ?? 0n) + BigInt(v.value_paisa), basis: m.get(v.as_of)?.basis ?? v.basis }), new Map<string, { total: bigint; basis: string | null }>())]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));

  const newTotal = parseAmountInput(total);
  const submitValue = async () => {
    if (newTotal === null) return;
    const items = splitByCost(BigInt(newTotal), assets.filter((a) => a.status !== 'sold')).map((p) => ({
      asset_id: p.asset_id,
      value_paisa: p.value_paisa.toString(),
      as_of: asOf,
      ...(basis.trim() ? { basis: basis.trim() } : {}),
    }));
    await api('/proposals', { method: 'POST', body: { type: 'valuation_update', title: t('holding.valueProposalTitle', { name: partner.name }), payload: { items } } });
    setTotal('');
    setBasis('');
  };

  // A withdrawal is an asset sale of the shop: a part (`amount_paisa`) or everything (`min_price_paisa`).
  const withdrawPaisa = parseAmountInput(withdrawAmount);
  const withdrawTooMuch = !everything && withdrawPaisa !== null && BigInt(withdrawPaisa) >= totals.value;
  const submitWithdraw = async () => {
    if (withdrawPaisa === null || withdrawTooMuch) return;
    const amount = BigInt(withdrawPaisa).toString();
    await api('/proposals', {
      method: 'POST',
      body: {
        type: 'asset_sale',
        title: everything ? t('holding.withdrawAllTitle', { name: partner.name }) : t('holding.withdrawPartTitle', { name: partner.name, amount: taka(amount) }),
        payload: { partner_id: partner.id, ...(everything ? { min_price_paisa: amount } : { amount_paisa: amount }) },
      },
    });
    setWithdrawAmount('');
    refresh();
  };

  return (
    <AdminPage>
      <Link to="/admin/assets" className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-muted hover:text-foreground">
        <span className="rotate-180"><Icon d={ICONS.chevron} size={16} /></span>
        {t('holding.back')}
      </Link>
      <AdminHeader
        title={partner.name}
        subtitle={`${t(`assets.${kind}`)} · ${t('holding.subtitle', { n: formatCount(shown.length) })}`}
        actions={isCashier && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setBuyOpen(true)} className={BTN_PRIMARY}>{t('holding.addEntry')}</button>
            <button type="button" onClick={() => setValueOpen(true)} className={BTN_SM_PRIMARY.replace('h-9', 'h-11')}>{t('holding.updateValue')}</button>
            {totals.count > 0 && (
              <button type="button" onClick={() => setWithdrawOpen(true)} className={BTN_SM_PRIMARY.replace('h-9', 'h-11')}>{t('holding.withdraw')}</button>
            )}
          </div>
        )}
      />

      <StatGrid>
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.wallet} label={t('holding.invested')} value={taka(totals.invested)} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.layers} label={t('holding.value')} value={taka(totals.value)}
          sub={totals.lastValued ? t('holding.valuedOn', { date: fmtDate(totals.lastValued) }) : t('holding.neverValued')} />
        <StatTile tone={totals.profit < 0n ? 'bg-bad-bg text-bad' : 'bg-ok-bg text-ok'} icon={ICONS.trend} label={t('holding.profit')} value={<Profit paisa={totals.profit} />} />
      </StatGrid>

      {isCashier && loose.data && loose.data.length > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-warn bg-warn-bg p-4">
          <p className="text-sm text-warn">{t('holding.looseHint', { n: formatCount(loose.data.length) })}</p>
          <button type="button" onClick={() => void adopt()} className={BTN_SM_PRIMARY}>{t('holding.adopt')}</button>
        </Card>
      )}

      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-base font-bold">{t('holding.contract')}</h2>
          {isCashier && (
            <button type="button" className={BTN_SM} onClick={() => {
              setTerms({
                name: partner.name,
                contract_date: partner.contract_date ?? '',
                rate_percent: partner.rate_percent?.toString() ?? '',
                period_months: partner.period_months?.toString() ?? '',
                sharing_policy: partner.sharing_policy ?? '',
                contract_note: partner.contract_note ?? '',
              });
              setAction({ kind: 'contract' });
            }}>{t('holding.editTerms')}</button>
          )}
        </div>
        <dl>
          <InfoRow label={t('holding.contractDate')} value={partner.contract_date ? fmtDate(partner.contract_date) : '—'} />
          <InfoRow label={t('holding.rate')} value={partner.rate_percent !== null ? `${formatCount(partner.rate_percent)}%${partner.period_months ? ` / ${t('holding.everyMonths', { n: formatCount(partner.period_months) })}` : ''}` : '—'} />
        </dl>
        <div className="mt-2 grid gap-3 text-sm md:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-muted">{t('holding.sharingPolicy')}</p>
            <p className="mt-1 whitespace-pre-line text-ink2">{partner.sharing_policy || '—'}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted">{t('holding.contractNote')}</p>
            <p className="mt-1 whitespace-pre-line text-ink2">{partner.contract_note || '—'}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
          <span className="text-xs font-semibold text-muted">{t('holding.contractPapers')}:</span>
          {contractPapers.map((d) => (
            <button key={d.id} type="button" onClick={() => void openPaper(d)} className="inline-flex items-center gap-1 rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-ink2 hover:bg-hover">
              <Icon d={ICONS.doc} size={14} />{d.title ?? t(`holding.doc.${d.doc_type ?? 'other'}`, { defaultValue: t('holding.doc.other') })}
            </button>
          ))}
          {contractPapers.length === 0 && <span className="rounded-full bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">{t('holding.noPapers')}</span>}
          {isCashier && <button type="button" onClick={() => { setDocType('contract'); setAction({ kind: 'cpaper' }); }} className={BTN_SM}>{t('holding.addPaper')}</button>}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-xs font-semibold text-muted">
                <th className="border-b border-border px-4 py-3 text-left">{t('holding.date')}</th>
                <th className="border-b border-border px-4 py-3 text-right">{t('holding.amount')}</th>
                <th className="border-b border-border px-4 py-3 text-left">{t('holding.account')}</th>
                <th className="border-b border-border px-4 py-3 text-left">{t('holding.remark')}</th>
                <th className="border-b border-border px-4 py-3 text-left">{t('holding.papers')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">{t('common.noData')}</td></tr>
              )}
              {shown.map((e) => {
                const a = assetOf.get(e.asset_id);
                const papers = papersOf(e.asset_id);
                return (
                  <tr key={e.seq} className="align-top">
                    <td className="whitespace-nowrap border-b border-border px-4 py-3">{fmtDate(e.entry_date)}</td>
                    <td className="whitespace-nowrap border-b border-border px-4 py-3 text-right font-semibold tabular-nums">{taka(e.amount_paisa)}</td>
                    <td className="whitespace-nowrap border-b border-border px-4 py-3">{t(`cashAccount.${e.account}`, { defaultValue: e.account })}</td>
                    <td className="border-b border-border px-4 py-3 text-ink2">
                      {e.ref_type === 'import' ? <span className="text-muted">{t('holding.imported')}</span> : (e.memo ?? '—')}
                    </td>
                    <td className="border-b border-border px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {papers.map((d) => (
                          <button key={d.id} type="button" onClick={() => void openPaper(d)} className="inline-flex items-center gap-1 rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-ink2 hover:bg-hover">
                            <Icon d={ICONS.doc} size={14} />{d.title ?? t(`holding.doc.${d.doc_type ?? 'other'}`, { defaultValue: t('holding.doc.other') })}
                          </button>
                        ))}
                        {papers.length === 0 && <span className="rounded-full bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">{t('holding.noPapers')}</span>}
                        {isCashier && <button type="button" onClick={() => setAction({ kind: 'paper', entry: e })} className={BTN_SM}>{t('holding.addPaper')}</button>}
                        {isCashier && a?.status === 'acquiring' && papers.length > 0 && (
                          <button type="button" onClick={() => setAction({ kind: 'complete', entry: e })} className={BTN_SM_PRIMARY}>{t('holding.complete')}</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {withdrawals.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-2 text-base font-bold">{t('holding.withdrawals')}</h2>
          <ul className="divide-y divide-border text-sm">
            {withdrawals.map((w) => {
              const gain = w.withdrawn_paisa && w.cost_paisa ? BigInt(w.withdrawn_paisa) - BigInt(w.cost_paisa) : null;
              return (
                <li key={w.proposal_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    {w.everything ? t('holding.withdrawalAll') : taka(w.amount_paisa)}
                    <span className="text-muted"> · {w.status === 'executed' && w.withdrawn_paisa
                      ? t('holding.withdrawalDone', { amount: taka(w.withdrawn_paisa), date: w.executed_on ? fmtDate(w.executed_on) : '—' })
                      : t('holding.withdrawalWaiting', { status: t(`status.proposal.${w.status}`) })}</span>
                  </span>
                  {gain !== null && gain !== 0n && (
                    <span className={`text-xs font-semibold ${gain > 0n ? 'text-ok' : 'text-bad'}`}>
                      {t(gain > 0n ? 'holding.gainOnWithdrawal' : 'holding.lossOnWithdrawal', { amount: taka(gain > 0n ? gain : -gain) })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-2 text-base font-bold">{t('holding.history')}</h2>
        {history.length === 0 ? <p className="text-sm text-muted">{t('holding.neverValued')}</p> : (
          <ul className="divide-y divide-border text-sm">
            {history.map(([date, h], i) => {
              const older = history[i + 1];
              return (
                <li key={date} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>{fmtDate(date)}{h.basis ? <span className="text-muted"> · {h.basis}</span> : null}</span>
                  <span className="flex items-center gap-3 tabular-nums">
                    {older && <Profit paisa={h.total - older[1].total} className="text-xs" />}
                    <span className="font-semibold">{taka(h.total)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <AdminDialog open={buyOpen} onClose={() => setBuyOpen(false)} title={t('holding.addEntry')} wide>
        <p className="mb-3 text-sm text-muted">{t('holding.addEntryHint')}</p>
        <CreateProposalForm
          type="investment_purchase"
          lockType
          initialValues={{ kind, name: partner.name, partner_id: partner.id }}
          onTypeChange={() => undefined}
          onCreated={() => { setBuyOpen(false); refresh(); }}
          onCancel={() => setBuyOpen(false)}
        />
      </AdminDialog>

      <ConfirmSheet
        open={valueOpen}
        onClose={() => setValueOpen(false)}
        title={t('holding.updateValue')}
        confirmLabel={t('common.submit')}
        canConfirm={newTotal !== null}
        onConfirm={submitValue}
      >
        <p className="text-sm text-muted">{t('holding.valueHint', { value: taka(totals.value) })}</p>
        <Field label={t('holding.newValue')}><input className="field mt-1 w-full" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></Field>
        <Field label={t('holding.asOf')}><input type="date" className="field mt-1 w-full" value={asOf} max={todayDhaka()} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Field label={t('holding.basis')}><input className="field mt-1 w-full" value={basis} onChange={(e) => setBasis(e.target.value)} /></Field>
        {newTotal !== null && <p className="text-sm">{t('holding.resultProfit')}: <Profit paisa={BigInt(newTotal) - totals.invested} className="font-bold" /></p>}
      </ConfirmSheet>

      <ConfirmSheet
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        title={t('holding.withdraw')}
        confirmLabel={t('common.submit')}
        canConfirm={withdrawPaisa !== null && !withdrawTooMuch}
        onConfirm={submitWithdraw}
      >
        <p className="text-sm text-muted">{t('holding.withdrawHint', { value: taka(totals.value), date: totals.lastValued ? fmtDate(totals.lastValued) : '—' })}</p>
        <div className="grid grid-cols-2 gap-2">
          {([false, true] as const).map((all) => (
            <button key={String(all)} type="button" onClick={() => { setEverything(all); setWithdrawAmount(all ? paisaToDecimal(totals.value) : ''); }} aria-pressed={everything === all}
              className={(everything === all ? BTN_SM_PRIMARY : BTN_SM).replace('h-9', 'h-11')}>
              {t(all ? 'holding.withdrawEverything' : 'holding.withdrawPart')}
            </button>
          ))}
        </div>
        <Field label={t(everything ? 'holding.withdrawMin' : 'holding.withdrawAmount')}>
          <input className="field mt-1 w-full" inputMode="decimal" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
        </Field>
        {everything && <p className="text-sm text-muted">{t('holding.withdrawMinHint', { value: taka(totals.value) })}</p>}
        {withdrawTooMuch && <p className="text-sm text-bad">{t('holding.withdrawTooMuch')}</p>}
        {!everything && withdrawPaisa !== null && !withdrawTooMuch && (
          <p className="text-sm">{t('holding.withdrawLeft', { value: taka(totals.value - BigInt(withdrawPaisa)) })}</p>
        )}
      </ConfirmSheet>

      <ConfirmSheet
        open={action !== null}
        onClose={close}
        title={action ? t(action.kind === 'contract' ? 'holding.editTerms' : action.kind === 'complete' ? 'holding.complete' : 'holding.addPaper') : ''}
        confirmLabel={t('common.confirm')}
        canConfirm={action?.kind === 'complete' ? note.trim().length >= 3 : action?.kind === 'contract' ? (terms.name ?? '').trim().length > 0 : file !== null}
        onConfirm={confirm}
      >
        {action && 'entry' in action && <p className="text-muted">{fmtDate(action.entry.entry_date)} · {taka(action.entry.amount_paisa)}</p>}
        {(action?.kind === 'paper' || action?.kind === 'cpaper') && (
          <>
            <Field label={t('assetsAdmin.docType')}>
              <select className="field mt-1 w-full" value={docType} onChange={(e) => setDocType(e.target.value)}>
                {action.kind === 'cpaper' && <option value="contract">{t('holding.doc.contract')}</option>}
                <option value="receipt">{t('assetsAdmin.docReceipt')}</option>
                <option value="deed">{t('assetsAdmin.docDeed')}</option>
                <option value="other">{t('assetsAdmin.docOther')}</option>
              </select>
            </Field>
            <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </>
        )}
        {action?.kind === 'complete' && (
          <>
            <Field label={t('assetsAdmin.note')}><textarea className="field mt-1 min-h-20 w-full" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <p className="text-sm text-muted">{t('assetsAdmin.completeHint')}</p>
          </>
        )}
        {action?.kind === 'contract' && (
          <>
            <Field label={t('holding.partnerName')}><input className="field mt-1 w-full" value={terms.name ?? ''} onChange={(e) => setTerms({ ...terms, name: e.target.value })} /></Field>
            <Field label={t('holding.contractDate')}><input type="date" className="field mt-1 w-full" value={terms.contract_date ?? ''} onChange={(e) => setTerms({ ...terms, contract_date: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('holding.rate')}><input className="field mt-1 w-full" inputMode="decimal" value={terms.rate_percent ?? ''} onChange={(e) => setTerms({ ...terms, rate_percent: e.target.value })} /></Field>
              <Field label={t('holding.periodMonths')}><input className="field mt-1 w-full" inputMode="numeric" value={terms.period_months ?? ''} onChange={(e) => setTerms({ ...terms, period_months: e.target.value })} /></Field>
            </div>
            <Field label={t('holding.sharingPolicy')}><textarea className="field mt-1 min-h-20 w-full" value={terms.sharing_policy ?? ''} onChange={(e) => setTerms({ ...terms, sharing_policy: e.target.value })} /></Field>
            <Field label={t('holding.contractNote')}><textarea className="field mt-1 min-h-20 w-full" value={terms.contract_note ?? ''} onChange={(e) => setTerms({ ...terms, contract_note: e.target.value })} /></Field>
          </>
        )}
      </ConfirmSheet>
    </AdminPage>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="block text-sm text-muted">{label}{children}</label>;
