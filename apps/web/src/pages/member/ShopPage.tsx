import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { ValuationRequestList, ValuationRequestSheet } from '../../components/ValuationUpdate';
import { api, apiBlob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { holdingTotals } from '../../lib/holding';
import { taka } from '../../lib/money';
import type { HoldingDocument, HoldingResponse } from '../../lib/types';
import { ASSET_META } from './AssetsPage';

/**
 * The member's view of one shop the fund invests with: what was put in, what it is worth, the
 * contract terms and every purchase with its papers. The cashier edits all of this on the admin
 * holding page; members see the same numbers. The member who looks after the shop sends its new
 * value from here (ASSUMPTIONS 115), and everyone sees the updates sent and what became of them.
 */
export function ShopPage() {
  const { id } = useParams();
  if (!id) return <Navigate to="/assets" replace />;
  return <ShopView id={id} />;
}

function ShopView({ id }: { id: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['holding', id], queryFn: () => api<HoldingResponse>(`/partners/${id}`) });
  const [sendOpen, setSendOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const openPaper = async (d: HoldingDocument) => {
    window.open(URL.createObjectURL(await apiBlob(`/files/${d.file_id}`)), '_blank', 'noopener');
  };
  const paperLabel = (d: HoldingDocument) => d.title ?? t(`holding.doc.${d.doc_type ?? 'other'}`, { defaultValue: t('holding.doc.other') });

  if (q.error) return <div className="p-4"><LoadError error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (!q.data) return <div className="p-4"><ListSkeleton rows={5} /></div>;

  const { partner, assets, entries, documents } = q.data;
  const meta = ASSET_META[partner.kind];
  const totals = holdingTotals(assets);
  const assetOf = new Map(assets.map((a) => [a.id, a]));
  const shown = entries.filter((e) => !e.reversed).sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1));
  const contractPapers = documents.filter((d) => d.entity_type === 'partner');
  const papersOf = (assetId: string) => documents.filter((d) => d.entity_type === 'asset' && d.entity_id === assetId);
  // Only the member who looks after this shop sends its value from here.
  const mine = !!me?.member_id && partner.custodian_member_id === me.member_id;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="px-4 pt-5 pb-2">
        <Link to="/assets" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
          {t('holding.back')}
        </Link>
        <div className="flex items-center gap-3">
          <span className={`grid h-11 w-11 flex-none place-items-center rounded-[14px] ${meta.bg} ${meta.color}`}>{meta.icon('h-6 w-6')}</span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold">{partner.name}</h1>
            <p className="text-sm text-muted">{t(meta.labelKey)} · {t('holding.subtitle', { n: formatCount(shown.length) })}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 space-y-3 px-4 py-2 pb-4">
        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-[14px] bg-soft p-3">
              <div className="text-xs text-muted">{t('holding.invested')}</div>
              <div className="mt-0.5 text-lg font-bold">{taka(totals.invested)}</div>
            </div>
            <div className="rounded-[14px] bg-soft p-3">
              <div className="text-xs text-muted">{t('holding.value')}</div>
              <div className="mt-0.5 text-lg font-bold">{taka(totals.value)}</div>
            </div>
          </div>
          <p className={`mt-3 text-sm font-semibold ${totals.profit > 0n ? 'text-ok' : totals.profit < 0n ? 'text-bad' : 'text-muted'}`}>
            {t('holding.profit')}: {totals.profit > 0n ? '+' : totals.profit < 0n ? '−' : ''}{taka(totals.profit < 0n ? -totals.profit : totals.profit)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {totals.lastValued ? t('holding.valuedOn', { date: fmtDate(totals.lastValued) }) : t('holding.neverValued')}
          </p>
          {mine && (
            <button type="button" onClick={() => { setSent(null); setSendOpen(true); }} className="mt-3 h-12 w-full rounded-2xl bg-primary font-bold text-primary-foreground">
              {t('valuation.send')}
            </button>
          )}
          {sent && <p role="status" className="mt-2 rounded-xl bg-ok-bg p-2.5 text-sm text-ok">{sent}</p>}
        </section>

        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <h2 className="card-head pb-3 text-base font-bold">{t('valuation.requests')}</h2>
          <div className="mt-2">
            <ValuationRequestList requests={q.data.valuation_requests ?? []} voteLink={(pid) => `/votes/${pid}`} />
          </div>
        </section>

        <section className="overflow-clip rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <h2 className="card-head pb-3 text-base font-bold">{t('holding.contract')}</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">{t('valuation.custodian')}</dt>
              <dd className="font-semibold">{partner.custodian_code ? `${partner.custodian_code} ${partner.custodian_name ?? ''}` : t('valuation.custodianNone')}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">{t('holding.contractDate')}</dt>
              <dd className="font-semibold">{partner.contract_date ? fmtDate(partner.contract_date) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">{t('holding.rate')}</dt>
              <dd className="font-semibold">
                {partner.rate_percent !== null
                  ? `${formatCount(partner.rate_percent)}%${partner.period_months ? ` / ${t('holding.everyMonths', { n: formatCount(partner.period_months) })}` : ''}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t('holding.sharingPolicy')}</dt>
              <dd className="mt-0.5 whitespace-pre-line">{partner.sharing_policy || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('holding.contractNote')}</dt>
              <dd className="mt-0.5 whitespace-pre-line">{partner.contract_note || '—'}</dd>
            </div>
          </dl>
          {contractPapers.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
              <span className="text-xs font-semibold text-muted">{t('holding.contractPapers')}:</span>
              {contractPapers.map((d) => (
                <button key={d.id} type="button" onClick={() => void openPaper(d)} className="min-h-9 rounded-full bg-soft px-3 text-xs font-semibold">
                  {paperLabel(d)}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-[20px] border border-border bg-card shadow-sm">
          {shown.length === 0 ? (
            <p className="py-8 text-center text-muted">{t('common.noData')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((e) => {
                const a = assetOf.get(e.asset_id);
                const papers = papersOf(e.asset_id);
                return (
                  <li key={e.seq} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold">{fmtDate(e.entry_date)}</div>
                        <div className="text-[0.8125rem] text-muted">
                          {t(`cashAccount.${e.account}`, { defaultValue: e.account })} · {e.ref_type === 'import' ? t('holding.imported') : (e.memo ?? '—')}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold tabular-nums">{taka(e.amount_paisa)}</div>
                        {a && (
                          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[0.6875rem] font-bold ${a.status === 'held' ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>
                            {t(`assets.status.${a.status}`)}
                          </span>
                        )}
                      </div>
                    </div>
                    {papers.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {papers.map((d) => (
                          <button key={d.id} type="button" onClick={() => void openPaper(d)} className="min-h-9 rounded-full bg-soft px-3 text-xs font-semibold">
                            {paperLabel(d)}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
      <ValuationRequestSheet
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        partner={partner}
        currentValue={totals.value}
        onSent={(route) => {
          setSent(t(route === 'auditor' ? 'valuation.sentAuditor' : 'valuation.sentVote'));
          void qc.invalidateQueries({ queryKey: ['holding', id] });
        }}
      />
    </div>
  );
}
