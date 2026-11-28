import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiBlob } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtPeriod, todayDhaka } from '../lib/dates';
import { formatCount } from '../lib/format';
import { taka } from '../lib/money';
import type { MandatePurchaseRow, MandateRow, PartnerRow } from '../lib/types';
import { CreateProposalForm } from '../pages/admin/ProposalsPage';
import { ConfirmSheet } from './ConfirmSheet';
import { AdminDialog, BTN_SM, BTN_SM_PRIMARY, Card, ICONS } from './admin';
import { MandatePurchaseSheet, mandateLeft } from './MandatePurchaseSheet';
import { Icon } from './ui';

const STATUS_TONE: Record<MandateRow['status'], string> = {
  active: 'bg-accent-soft text-accent',
  upcoming: 'bg-blue-bg text-blue',
  expired: 'bg-soft text-muted',
  ended: 'bg-soft text-muted',
};

type Sheet = { kind: 'buy'; mandate: MandateRow } | { kind: 'end'; mandate: MandateRow } | { kind: 'reverse'; purchase: MandatePurchaseRow } | null;

/**
 * A shop's standing investment approval (ASSUMPTIONS 131): the members vote once for a monthly limit
 * over a set number of months; each month's purchase is then recorded here with the shop's receipt,
 * without another vote. Everyone sees it; the cashier records, the cashier or auditor may end it early.
 */
export function MandateCard({ partner, mandates, onChanged }: { partner: PartnerRow; mandates: MandateRow[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const isStaff = isCashier || (me?.roles.includes('auditor') ?? false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [voteOpen, setVoteOpen] = useState(false);
  const [reason, setReason] = useState('');

  const current = mandates.find((m) => m.status === 'active' || m.status === 'upcoming');
  const shown = current ?? mandates[0];
  const purchases = useQuery({
    queryKey: ['mandate-purchases', shown?.id],
    queryFn: () => api<{ items: MandatePurchaseRow[] }>(`/mandates/${shown!.id}/purchases`),
    enabled: !!shown,
  });

  const reset = () => {
    setSheet(null);
    setReason('');
  };
  const done = () => {
    void purchases.refetch();
    onChanged();
  };

  const run = async () => {
    if (!sheet || sheet.kind === 'buy') return;
    if (sheet.kind === 'end') {
      await api(`/mandates/${sheet.mandate.id}/end`, { method: 'POST', body: { reason: reason.trim() } });
    } else {
      await api(`/mandate-purchases/${sheet.purchase.asset_id}/reverse-request`, { method: 'POST', body: { reason: reason.trim() } });
    }
    done();
  };

  const openReceipt = async (fileId: string) => {
    window.open(URL.createObjectURL(await apiBlob(`/files/${fileId}`)), '_blank', 'noopener');
  };

  return (
    <Card className="p-5">
      <div className="card-head mb-3 flex flex-wrap items-center justify-between gap-2 pb-3">
        <h2 className="text-base font-bold">{t('mandate.title')}</h2>
        {isCashier && !current && (
          <button type="button" onClick={() => setVoteOpen(true)} className={BTN_SM_PRIMARY}>{t('mandate.propose')}</button>
        )}
      </div>

      {!shown ? (
        <p className="text-sm text-muted">{t('mandate.none')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold tabular-nums">{t('mandate.perMonth', { amount: taka(shown.monthly_max_paisa) })}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[shown.status]}`}>{t(`mandate.status.${shown.status}`)}</span>
          </div>
          <p className="mt-1 text-sm text-muted">
            {t('mandate.span', { from: fmtPeriod(shown.first_period), to: fmtPeriod(shown.last_period) })}
            {shown.ended_on && ` · ${t('mandate.endedOn', { date: fmtDate(shown.ended_on), reason: shown.end_reason ?? '' })}`}
          </p>

          {shown.status === 'active' && (
            <div className="mt-3 rounded-xl bg-soft p-3 text-sm">
              <div className="flex justify-between gap-2">
                <span>{t('mandate.thisMonth', { month: fmtPeriod(todayDhaka().slice(0, 7)) })}</span>
                <span className="font-semibold tabular-nums">{taka(shown.used_this_month_paisa)} / {taka(shown.monthly_max_paisa)}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-border" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.min(100, Number((BigInt(shown.used_this_month_paisa) * 100n) / BigInt(shown.monthly_max_paisa)))}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted">{t('mandate.left', { amount: taka(mandateLeft(shown)) })}</p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {isCashier && shown.status === 'active' && (
              <button type="button" onClick={() => setSheet({ kind: 'buy', mandate: shown })} className={BTN_SM_PRIMARY}>
                <Icon d={ICONS.plus} size={16} />{t('mandate.addPurchase')}
              </button>
            )}
            {isStaff && (shown.status === 'active' || shown.status === 'upcoming') && (
              <button type="button" onClick={() => setSheet({ kind: 'end', mandate: shown })} className={BTN_SM}>{t('mandate.end')}</button>
            )}
          </div>

          {(purchases.data?.items.length ?? 0) > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border text-sm">
              {purchases.data!.items.slice(0, 12).map((p) => (
                <li key={p.asset_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <span className={`font-semibold tabular-nums ${p.reversed ? 'text-muted line-through' : ''}`}>{taka(p.original_paisa)}</span>
                    <span className="ml-2 text-muted">{fmtDate(p.entry_date)}</span>
                    <div className="text-xs text-muted">
                      {p.payment_id ? t('mandate.fromMember', { member: `${p.member_code ?? ''} ${p.member_name ?? ''}`.trim() }) : t('mandate.fromFund')}
                      {p.note && ` · ${p.note}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {p.reversed && <span className="rounded-full bg-soft px-2.5 py-0.5 text-xs font-semibold text-muted">{t('mandate.reversed')}</span>}
                    {p.reversal_pending && <span className="rounded-full bg-warn-bg px-2.5 py-0.5 text-xs font-semibold text-warn">{t('mandate.reversalPending')}</span>}
                    {p.receipt_file_id && (
                      <button type="button" onClick={() => void openReceipt(p.receipt_file_id!)} className="inline-flex items-center gap-1 rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-ink2 hover:bg-hover">
                        <Icon d={ICONS.doc} size={14} />{t('holding.doc.receipt')}
                      </button>
                    )}
                    {isCashier && !p.payment_id && !p.reversed && !p.reversal_pending && (
                      <button type="button" onClick={() => setSheet({ kind: 'reverse', purchase: p })} className={BTN_SM}>{t('mandate.reverse')}</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="mt-3 text-xs text-muted">{t('mandate.hint')}</p>

      <AdminDialog open={voteOpen} onClose={() => setVoteOpen(false)} title={t('mandate.propose')} wide>
        <p className="mb-3 text-sm text-muted">{t('mandate.proposeHint')}</p>
        <CreateProposalForm
          type="investment_mandate"
          lockType
          initialValues={{ partner_id: partner.id, first_period: todayDhaka().slice(0, 7), months: '12' }}
          hide={['partner_id']}
          defaultTitle={t('mandate.voteTitle', { name: partner.name })}
          onTypeChange={() => undefined}
          onCreated={() => { setVoteOpen(false); onChanged(); }}
          onCancel={() => setVoteOpen(false)}
        />
      </AdminDialog>

      <MandatePurchaseSheet partnerName={partner.name} mandate={sheet?.kind === 'buy' ? sheet.mandate : null} onClose={reset} onSaved={done} />

      <ConfirmSheet
        open={sheet !== null && sheet.kind !== 'buy'}
        onClose={reset}
        title={sheet?.kind === 'end' ? t('mandate.end') : t('mandate.reverse')}
        confirmLabel={t('common.confirm')}
        tone="danger"
        canConfirm={reason.trim().length >= 3}
        onConfirm={run}
      >
        {sheet && sheet.kind !== 'buy' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {sheet.kind === 'end' ? t('mandate.endHint') : t('mandate.reverseHint', { amount: taka(sheet.purchase.original_paisa), date: fmtDate(sheet.purchase.entry_date) })}
            </p>
            <label className="field-label">
              {t('mandate.reason')}
              <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        )}
      </ConfirmSheet>
      {/* keep the count of past approvals visible when one has ended and none is running */}
      {!current && mandates.length > 1 && <p className="mt-2 text-xs text-muted">{t('mandate.past', { n: formatCount(mandates.length) })}</p>}
    </Card>
  );
}
