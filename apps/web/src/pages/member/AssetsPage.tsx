import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { formatCount } from '../../lib/format';
import { holdingTotals } from '../../lib/holding';
import { taka } from '../../lib/money';
import type { AssetRow, NavResponse, PartnerRow } from '../../lib/types';

const ACTIVE_STATUSES = new Set(['held', 'acquiring']);

export const ASSET_META: Record<
  AssetRow['kind'],
  { labelKey: string; color: string; bg: string; icon: (c: string) => JSX.Element }
> = {
  gold: {
    labelKey: 'assets.gold',
    color: 'text-warn',
    bg: 'bg-warn-bg',
    icon: (c) => (
      <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 8h10l4 9H3z" /><path d="M10 8l-1.5 9" /><path d="M14 8l1.5 9" /></svg>
    ),
  },
  land: {
    labelKey: 'assets.land',
    color: 'text-primary',
    bg: 'bg-primary-soft',
    icon: (c) => (
      <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 19l5-9 4 6 3-4 6 7z" /></svg>
    ),
  },
  house: {
    labelKey: 'assets.house',
    color: 'text-blue',
    bg: 'bg-blue-bg',
    icon: (c) => (
      <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 21V5l8-2v18" /><path d="M12 9h8v12" /><path d="M4 21h16" /><path d="M7 9h2" /><path d="M7 13h2" /><path d="M7 17h2" /><path d="M15 13h2" /><path d="M15 17h2" /></svg>
    ),
  },
  other: {
    labelKey: 'assets.other',
    color: 'text-muted',
    bg: 'bg-soft',
    icon: (c) => (
      <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /><path d="M12 13v8" /></svg>
    ),
  },
};

function isStale(valueAsOf: string | null): boolean {
  if (!valueAsOf) return true;
  const then = new Date(valueAsOf);
  const now = new Date();
  const days = (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24);
  return days > 365;
}

export function AssetsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const assets = useQuery({
    queryKey: ['assets'],
    queryFn: () => api<{ items: AssetRow[] }>('/assets?limit=200'),
  });
  const nav = useQuery({
    queryKey: ['nav'],
    queryFn: () => api<NavResponse>('/nav'),
  });

  const partners = useQuery({
    queryKey: ['partners'],
    queryFn: () => api<{ items: PartnerRow[] }>('/partners'),
  });

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['assets'] }),
    qc.invalidateQueries({ queryKey: ['nav'] }),
    qc.invalidateQueries({ queryKey: ['partners'] }),
  ]);

  const staleCount = nav.data?.stale_valuations.length ?? 0;

  const active = (assets.data?.items ?? []).filter((a) => ACTIVE_STATUSES.has(a.status));

  // Purchases made through a shop are shown as that shop's card, like the admin Investments tab;
  // everything else (own land, houses, gold with no shop yet) keeps its own card.
  const shops = (partners.data?.items ?? [])
    .map((p) => ({ partner: p, items: active.filter((a) => a.partner_id === p.id) }))
    .filter((s) => s.items.length > 0);
  const shopIds = new Set(shops.map((s) => s.partner.id));
  const own = active.filter((a) => !a.partner_id || !shopIds.has(a.partner_id));

  if (assets.error) {
    return (
      <div className="p-4">
        <LoadError error={assets.error} onRetry={() => void assets.refetch()} />
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="flex min-h-screen flex-col bg-background">
        <header className="px-4 pt-5 pb-2">
          <h1 className="text-2xl font-bold">{t('assets.fundAssets')}</h1>
          <p className="text-sm text-muted">{t('assets.allAssetStatus')}</p>
        </header>

        <main className="flex-1 space-y-3 overflow-y-auto px-4 py-2 pb-4">
          {/* The same four figures as the web Assets page: a summary of the fund, not an asset of its own */}
          <section className="grid grid-cols-2 gap-2.5" aria-label={t('assets.fundAssets')}>
            <Stat label={t('assetsAdmin.netAssets')} value={nav.data ? taka(nav.data.net_assets_paisa) : null} />
            <Stat label={t('assetsAdmin.navPerShare')} value={nav.data ? taka(nav.data.nav_per_share_paisa) : null} />
            <Stat label={t('assetsAdmin.shares')} value={nav.data ? formatCount(Number(nav.data.shares_outstanding)) : null} />
            <Stat label={t('assetsAdmin.statInvested')} value={assets.data ? taka(holdingTotals(active).invested) : null} />
          </section>
          {staleCount > 0 && (
            <div className="flex items-center gap-2 rounded-xl bg-warn-bg p-2.5 text-xs font-semibold text-warn">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18h.01" /></svg>
              {t('assets.staleCount', { count: staleCount })}
            </div>
          )}

          {!assets.data || !partners.data ? (
            <ListSkeleton rows={3} />
          ) : active.length === 0 ? (
            <p className="py-8 text-center text-muted">{t('common.noData')}</p>
          ) : (
            <>
              {shops.map((s) => <ShopCard key={s.partner.id} partner={s.partner} items={s.items} />)}
              {own.map((asset) => <AssetCard key={asset.id} asset={asset} />)}
            </>
          )}
        </main>
      </div>
    </PullToRefresh>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-[18px] border border-border bg-card p-3.5">
      <div className="text-xs text-muted">{label}</div>
      {value === null ? <Skeleton className="mt-1.5 h-6 w-24" /> : <div className="mt-0.5 text-lg font-bold leading-tight">{value}</div>}
    </div>
  );
}

function ShopCard({ partner, items }: { partner: PartnerRow; items: AssetRow[] }) {
  const { t } = useTranslation();
  const meta = ASSET_META[partner.kind];
  const totals = holdingTotals(items);

  return (
    <Link
      to={`/assets/shop/${partner.id}`}
      className="block rounded-[20px] border border-border bg-card p-4 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="shop-card"
    >
      <div className="flex items-center gap-3">
        <span className={`grid h-11 w-11 flex-none place-items-center rounded-[14px] ${meta.bg} ${meta.color}`}>
          {meta.icon('h-6 w-6')}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[1.0625rem] font-bold">{partner.name}</div>
          <div className="text-[0.8125rem] text-muted">
            {t(meta.labelKey)} · {t('holding.subtitle', { n: formatCount(totals.count) })}
          </div>
        </div>
        <svg className="h-5 w-5 shrink-0 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
      </div>

      <div className="mt-3.5 grid grid-cols-2 gap-2.5">
        <div className="rounded-[14px] bg-background p-3">
          <div className="text-xs text-muted">{t('holding.invested')}</div>
          <div className="mt-0.5 text-lg font-bold">{taka(totals.invested)}</div>
        </div>
        <div className="rounded-[14px] bg-background p-3">
          <div className="text-xs text-muted">{t('holding.value')}</div>
          <div className="mt-0.5 text-lg font-bold">{taka(totals.value)}</div>
        </div>
      </div>

      <p className={`mt-3 border-t border-border pt-3 text-sm font-semibold ${totals.profit > 0n ? 'text-ok' : totals.profit < 0n ? 'text-bad' : 'text-muted'}`}>
        {t('holding.profit')}: {totals.profit > 0n ? '+' : totals.profit < 0n ? '−' : ''}{taka(totals.profit < 0n ? -totals.profit : totals.profit)}
      </p>
    </Link>
  );
}

export function AssetCard({ asset }: { asset: AssetRow }) {
  const { t } = useTranslation();
  const meta = ASSET_META[asset.kind];
  const cost = BigInt(asset.cost_paisa);
  const acquiring = asset.status === 'acquiring';

  return (
    <article className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className={`grid h-11 w-11 flex-none place-items-center rounded-[14px] ${meta.bg} ${meta.color}`}>
          {meta.icon('h-6 w-6')}
        </span>
        <div className="flex-1">
          <div className="text-[1.0625rem] font-bold">
            {asset.name}
            {asset.quantity && asset.unit && (
              <span className="ml-1.5 text-sm font-normal text-muted">
                · {asset.quantity} {t(asset.unit === 'vori' ? 'assets.vori' : 'assets.gram')}
              </span>
            )}
          </div>
          <div className="text-[0.8125rem] text-muted">
            {asset.location ?? t(meta.labelKey)} · {asset.acquired_on ? asset.acquired_on : t('assets.noAcquireDate')}
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            asset.status === 'held' ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'
          }`}
        >
          {t(`assets.status.${asset.status}`)}
        </span>
      </div>

      <div className="mt-3.5 grid grid-cols-2 gap-2.5">
        <div className="rounded-[14px] bg-background p-3">
          <div className="text-xs text-muted">{t('assets.cost')}</div>
          <div className="mt-0.5 text-lg font-bold">{taka(cost)}</div>
        </div>
        <div className="rounded-[14px] bg-background p-3">
          <div className="text-xs text-muted">{t('assets.latestValuation')}</div>
          <div className="mt-0.5 text-lg font-bold">{taka(asset.latest_value_paisa ?? asset.cost_paisa)}</div>
          {asset.latest_value_as_of && (
            <div className="text-[0.6875rem] text-muted">{asset.latest_value_as_of}</div>
          )}
        </div>
      </div>

      {acquiring && (
        <div className="mt-3 rounded-xl bg-background p-3 text-[0.8125rem] text-muted">
          {t('assets.acquiringNote')}
        </div>
      )}

      {asset.status === 'held' && isStale(asset.latest_value_as_of) && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-warn-bg p-3 text-[0.8125rem] font-semibold text-warn">
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18h.01" /></svg>
          {t('assets.valuationStale')}
        </div>
      )}
    </article>
  );
}
