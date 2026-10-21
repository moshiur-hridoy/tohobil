import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Tabs from '@radix-ui/react-tabs';
import { NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS } from '@barakah/shared';
import { Chip, Icon } from '../../components/ui';
import { AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, Card } from '../../components/admin';
import { Skeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { fmtDate, fmtInstant, fmtPeriod, todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { arrearsOf, taka } from '../../lib/money';
import { charityBalance, interimNetAssets } from '../../lib/nav';
import type { AccountBalance, ApprovalRow, MatrixCell, MatrixResponse, MemberRow, ObjectionRow, Page, PaymentRow, ProposalSummary } from '../../lib/types';

const ALL = 200;
const TREND_MONTHS = 6;
const TABLE_ROWS = 8;
/** The offline copy is a monthly task (systemStatus.offlineHint); older than this is flagged. */
const OFFLINE_COPY_MAX_DAYS = 31;

const ICONS = {
  trend: 'M3 17l6-6 4 4 8-9M15 6h6v6',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5M12 16v.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  wallet: 'M3 7h18v12H3zM3 11h18M16 15h2',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  flag: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  vote: 'M4 4h16v16H4zM9 12l2 2 4-4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  grid: 'M4 5h16v14H4zM4 10h16M10 5v14',
  check: 'M5 12l5 5 9-10',
  chevron: 'M9 5l7 7-7 7',
} as const;

/** "2026-10" plus `n` months (n may be negative), as "YYYY-MM". */
function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Whole days from one YYYY-MM-DD business date to another. */
function daysBetween(from: string, to: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Integer percent of two paisa amounts, without going through floating point money. */
const percent = (part: bigint, whole: bigint): number => (whole > 0n ? Number((part * 100n) / whole) : 0);

const balanceOf = (accounts: AccountBalance[], codes: readonly string[]): bigint =>
  accounts.filter((a) => codes.includes(a.code)).reduce((sum, a) => sum + BigInt(a.natural_balance_paisa), 0n);

interface SystemStatus {
  backup: { ok: boolean; finished?: string } | null;
  restore_test: { ok: boolean; finished?: string } | null;
  offline_copy: { on: string } | null;
}

/** Every number here is computed from the API; nothing on this page is typed in (spec 19.5). */
export function AdminDashboard() {
  const { t } = useTranslation();
  const today = todayDhaka();
  const period = today.slice(0, 7);
  const from = addMonths(period, -(TREND_MONTHS - 1));

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const accounts = useQuery({ queryKey: ['balances'], queryFn: () => api<{ items: AccountBalance[] }>('/accounts/balances') });
  const matrix = useQuery({ queryKey: ['matrix', from, period], queryFn: () => api<MatrixResponse>(`/matrix?from=${from}&to=${period}`) });
  const pending = useQuery({ queryKey: ['payments', 'pending'], queryFn: () => api<Page<PaymentRow>>(`/payments?status=pending&limit=${ALL}`) });
  const approvals = useQuery({ queryKey: ['approvals', 'pending'], queryFn: () => api<Page<ApprovalRow>>(`/approvals?status=pending&limit=${ALL}`) });
  const objections = useQuery({ queryKey: ['objections', 'open'], queryFn: () => api<Page<ObjectionRow>>(`/objections?status=open&limit=${ALL}`) });
  const votes = useQuery({ queryKey: ['proposals', 'dashboard', 'open'], queryFn: () => api<Page<ProposalSummary>>(`/proposals?status=open&limit=${ALL}`) });
  const verify = useQuery({ queryKey: ['ledger-verify'], queryFn: () => api<{ ok: boolean; count: number }>('/ledger/verify'), staleTime: 60_000 });
  const system = useQuery({ queryKey: ['system-status'], queryFn: () => api<SystemStatus>('/system/status'), refetchInterval: 60_000 });

  const failed = [members, accounts, matrix, pending].find((q) => q.error);
  const more = (page: Page<unknown> | undefined) => (page?.next_cursor ? '+' : '');
  const pendingCount = pending.data ? `${formatCount(pending.data.items.length)}${more(pending.data)}` : null;

  return (
    <AdminPage>
      {/* Header: where we are in time, and the two places the cashier goes most */}
      <AdminHeader
        title={t('admin.dashboard')}
        subtitle={t('adminDash.today', { date: fmtDate(today) })}
        actions={
          <>
            <Link to="/admin/matrix" className={BTN_SECONDARY}>
              <Icon d={ICONS.grid} size={18} />
              {t('admin.nav.matrix')}
            </Link>
            <Link to="/admin/payments" className={BTN_PRIMARY}>
              <Icon d={ICONS.wallet} size={18} sw={2} />
              {t('admin.nav.payments')}
              {pending.data && pending.data.items.length > 0 && (
                <span className="grid min-w-6 place-items-center rounded-full bg-primary-foreground px-1.5 text-xs font-bold text-primary">{pendingCount}</span>
              )}
            </Link>
          </>
        }
      />

      {failed?.error && <LoadError error={failed.error} onRetry={() => void failed.refetch()} />}

      {verify.data?.ok === false && (
        <Link to="/admin/system" role="alert" className="flex items-center gap-3 rounded-2xl border border-bad bg-bad-bg p-4 text-sm font-medium text-bad">
          <Icon d={ICONS.flag} />
          <span className="flex-1">{t('adminDash.ledgerAlert')}</span>
          <Icon d={ICONS.chevron} size={18} />
        </Link>
      )}

      <NetAssetsHero accounts={accounts.data?.items} members={members.data?.items} matrix={matrix.data} />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <CollectedTile totals={matrix.data?.totals_by_period[period]} loaded={!!matrix.data} />
        <OverdueTile members={members.data?.items} />
        <PendingTile page={pending.data} count={pendingCount} />
        <Kpi
          label={t('adminDash.charityBalance')}
          tone="bg-vio-bg text-vio"
          icon={ICONS.heart}
          to="/admin/charity"
          value={accounts.data ? taka(charityBalance(accounts.data.items)) : null}
          footer={t('adminDash.charityHint')}
        />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <MemberStatus matrix={matrix.data} members={members.data?.items} period={period} />
        <div className="space-y-5">
          <Tasks pending={pending.data} approvals={approvals.data} objections={objections.data} votes={votes.data} />
          <Safety system={system.data} systemFailed={!!system.error} verify={verify.data} today={today} />
        </div>
      </div>
    </AdminPage>
  );
}

function NetAssetsHero({ accounts, members, matrix }: { accounts?: AccountBalance[]; members?: MemberRow[]; matrix?: MatrixResponse }) {
  const { t } = useTranslation();
  const active = members?.filter((m) => m.status === 'active');
  const breakdown: Array<[string, string | null]> = [
    [t('adminDash.cashAndBank'), accounts ? taka(balanceOf(accounts, NAV_CASH_ACCOUNTS)) : null],
    [t('adminDash.assetsAtCost'), accounts ? taka(balanceOf(accounts, ['INVESTMENTS_AT_COST'])) : null],
    [t('adminDash.owedToOthers'), accounts ? taka(balanceOf(accounts, NAV_DEDUCTION_ACCOUNTS)) : null],
    [
      t('adminDash.membersShares'),
      active ? t('adminDash.membersSharesValue', { members: formatCount(active.length), shares: formatCount(active.reduce((s, m) => s + m.shares, 0)) }) : null,
    ],
  ];

  return (
    <Card className="relative overflow-hidden">
      {/* a soft brand glow behind the headline figure */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(90% 120% at 0% 0%, var(--primary-soft) 0%, transparent 60%)' }} />
      <div className="relative grid gap-8 p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:p-7">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink2">{t('admin.netAssets')}</p>
          {accounts ? (
            <p className="mt-1.5 text-[2.75rem] font-bold leading-tight tracking-tight tabular-nums">{taka(interimNetAssets(accounts))}</p>
          ) : (
            <Skeleton className="mt-2 h-12 w-64" />
          )}
          <p className="mt-2 text-sm text-muted">{t('adminDash.netAssetsHint')}</p>
          <div className="my-5 h-px bg-border" />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
            {breakdown.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[0.8125rem] text-muted">{label}</dt>
                {value === null ? <Skeleton className="mt-1 h-6 w-24" /> : <dd className="mt-0.5 truncate text-lg font-bold tabular-nums">{value}</dd>}
              </div>
            ))}
          </dl>
        </div>
        <CollectionTrend matrix={matrix} />
      </div>
    </Card>
  );
}

/**
 * Monthly dues: a ghost bar for what was expected and a solid bar for what came in, on one axis.
 * Months before the fund had any dues are dropped. Hover or focus a month for its numbers.
 */
function CollectionTrend({ matrix }: { matrix?: MatrixResponse }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);

  if (!matrix) return <Skeleton className="h-64 w-full" />;

  const months = matrix.periods
    .map((p) => {
      const tot = matrix.totals_by_period[p];
      return { period: p, due: BigInt(tot?.due_paisa ?? '0'), paid: BigInt(tot?.paid_paisa ?? '0') };
    })
    .filter((m, i, all) => all.slice(0, i + 1).some((x) => x.due > 0n || x.paid > 0n));
  const max = months.reduce((hi, m) => (m.due > hi ? m.due : m.paid > hi ? m.paid : hi), 0n);
  const totalDue = months.reduce((s, m) => s + m.due, 0n);
  const totalPaid = months.reduce((s, m) => s + m.paid, 0n);
  const short = (p: string) => fmtPeriod(p).split(' ')[0] ?? p;
  const last = months.length - 1;
  const shown = active ?? last;

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[1.0625rem] font-bold">{t('adminDash.trendTitle')}</h2>
          {months.length > 0 && (
            <p className="mt-0.5 text-[0.8125rem] text-muted">{t('adminDash.trendSub', { from: fmtPeriod(months[0]!.period), to: fmtPeriod(months[last]!.period) })}</p>
          )}
        </div>
        <div className="flex gap-4 text-[0.8125rem] text-ink2">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary" />{t('adminDash.legendPaid')}</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-input bg-soft" />{t('adminDash.legendDue')}</span>
        </div>
      </div>

      {months.length === 0 || max === 0n ? (
        <p className="grid flex-1 place-items-center py-12 text-sm text-muted">{t('adminDash.trendEmpty')}</p>
      ) : (
        <>
          {/* readout of the month under the pointer (the latest month otherwise) */}
          <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-live="polite">
            <span className="text-sm font-semibold text-ink2">{fmtPeriod(months[shown]!.period)}</span>
            <span className="text-xl font-bold tabular-nums">{taka(months[shown]!.paid)}</span>
            <span className="text-sm text-muted tabular-nums">/ {taka(months[shown]!.due)}</span>
            {months[shown]!.due > 0n && (
              <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-bold text-primary tabular-nums">{formatCount(percent(months[shown]!.paid, months[shown]!.due))}%</span>
            )}
          </div>
          <div className="mt-3 flex h-44 items-end gap-2 border-b border-border sm:gap-3" onMouseLeave={() => setActive(null)}>
            {months.map((m, i) => {
              const dueH = percent(m.due, max);
              const paidH = percent(m.paid, max);
              return (
                <button
                  key={m.period}
                  type="button"
                  aria-label={t('adminDash.trendBar', { month: fmtPeriod(m.period), paid: taka(m.paid), due: taka(m.due) })}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className={`relative h-full flex-1 rounded-t-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${shown === i ? 'bg-hover' : ''}`}
                >
                  <span className="absolute inset-x-[18%] bottom-0 rounded-t-md border border-b-0 border-input bg-soft" style={{ height: `${dueH}%` }} />
                  <span
                    className={`absolute inset-x-[18%] bottom-0 rounded-t-md transition-[height] duration-500 ${i === last ? 'bg-primary' : 'bg-primary opacity-70'}`}
                    style={{ height: `${paidH}%` }}
                  />
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2 sm:gap-3">
            {months.map((m, i) => (
              <span key={m.period} className={`flex-1 truncate text-center text-xs ${shown === i ? 'font-semibold text-foreground' : 'text-muted'}`}>{short(m.period)}</span>
            ))}
          </div>
          <p className="mt-3 text-[0.8125rem] text-muted">{t('adminDash.trendTotal', { paid: taka(totalPaid), due: taka(totalDue) })}</p>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Kpi({ label, value, valueClass = '', tone, icon, to, footer, children }: {
  label: string;
  value: string | null;
  valueClass?: string;
  tone: string;
  icon: string;
  to?: string;
  footer?: string | null;
  children?: ReactNode;
}) {
  const body = (
    <div className={`flex h-full flex-col rounded-[18px] border border-border bg-card px-[18px] py-4 shadow-card ${to ? 'transition-all hover:border-input hover:shadow-lift motion-safe:hover:-translate-y-0.5' : ''}`}>
      <div className="flex items-center gap-2.5">
        <Chip tone={tone} d={icon} />
        <p className="flex-1 text-sm text-ink2">{label}</p>
        {to && <span className="text-muted"><Icon d={ICONS.chevron} size={16} /></span>}
      </div>
      {value === null ? <Skeleton className="mt-3 h-8 w-28" /> : <p className={`mt-3 text-[1.625rem] font-bold leading-tight tabular-nums ${valueClass}`}>{value}</p>}
      {children}
      {footer && <p className="mt-auto pt-2 text-xs text-muted">{footer}</p>}
    </div>
  );
  return to ? <Link to={to} className="block rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</Link> : body;
}

function CollectedTile({ totals, loaded }: { totals?: { due_paisa: string; paid_paisa: string }; loaded: boolean }) {
  const { t } = useTranslation();
  const due = BigInt(totals?.due_paisa ?? '0');
  const paid = BigInt(totals?.paid_paisa ?? '0');
  const pct = percent(paid, due);
  return (
    <Kpi
      label={t('adminDash.collectedThisMonth')}
      tone="bg-primary-soft text-primary"
      icon={ICONS.trend}
      to="/admin/matrix"
      value={loaded ? taka(paid) : null}
      footer={loaded ? (due > 0n ? t('adminDash.pctOfTarget', { pct: formatCount(pct), target: taka(due) }) : t('adminDash.noDuesYet')) : null}
    >
      {loaded && due > 0n && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </Kpi>
  );
}

function OverdueTile({ members }: { members?: MemberRow[] }) {
  const { t } = useTranslation();
  const overdue = members?.filter((m) => arrearsOf(m) > 0n) ?? [];
  const total = overdue.reduce((s, m) => s + arrearsOf(m), 0n);
  return (
    <Kpi
      label={t('adminDash.overdueMembers')}
      tone="bg-bad-bg text-bad"
      icon={ICONS.alert}
      to="/admin/matrix"
      value={members ? t('adminDash.people', { n: formatCount(overdue.length) }) : null}
      valueClass={overdue.length > 0 ? 'text-bad' : ''}
      footer={members ? (overdue.length > 0 ? t('adminDash.totalOutstanding', { amount: taka(total) }) : t('adminDash.allUpToDate')) : null}
    />
  );
}

function PendingTile({ page, count }: { page?: Page<PaymentRow>; count: string | null }) {
  const { t } = useTranslation();
  const oldest = page?.items.reduce<PaymentRow | null>((o, p) => (!o || p.submitted_at < o.submitted_at ? p : o), null);
  return (
    <Kpi
      label={t('adminDash.pendingVerify')}
      tone="bg-warn-bg text-warn"
      icon={ICONS.clock}
      to="/admin/payments"
      value={count === null ? null : t('adminDash.countItems', { n: count })}
      footer={page ? (oldest ? t('adminDash.oldestPending', { name: oldest.member_name, amount: taka(oldest.amount_paisa) }) : t('adminDash.allVerified')) : null}
    />
  );
}

/* ---------------------------------------------------------------------------------------------- */

type Filter = 'all' | 'overdue' | 'pending' | 'paid';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'adminDash.filterAll'],
  ['overdue', 'adminDash.filterOverdue'],
  ['pending', 'adminDash.filterPending'],
  ['paid', 'adminDash.filterPaid'],
];

interface StatusRow {
  id: string;
  code: string;
  name: string;
  cell: MatrixCell | null;
  /** Arrears across all months (overdue dues + unpaid fines), not just this one. */
  owes: bigint;
  /** This month's state, which the pill and the bar show. */
  month: 'overdue' | 'pending' | 'open' | 'paid';
}

/** Behind on payments first (largest first), then payments being verified, then open, then paid. */
const rank = (r: StatusRow): number => (r.owes > 0n ? 0 : r.month === 'pending' ? 1 : r.month === 'paid' ? 3 : 2);

const inFilter = (r: StatusRow, f: Filter): boolean =>
  f === 'all' || (f === 'overdue' ? r.owes > 0n : f === 'pending' ? r.month === 'pending' : r.month === 'paid');

function MemberStatus({ matrix, members, period }: { matrix?: MatrixResponse; members?: MemberRow[]; period: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');

  const byId = new Map(members?.map((m) => [m.id, m]));
  const rows: StatusRow[] = (matrix?.members ?? [])
    .filter((m) => m.member_status === 'active' || m.cells[period])
    .map((m) => {
      const cell = m.cells[period] ?? null;
      const member = byId.get(m.member_id);
      const owes = member ? arrearsOf(member) : 0n;
      const month: StatusRow['month'] =
        cell?.pending ? 'pending'
        : cell?.status === 'paid' || cell?.status === 'paid_late' ? 'paid'
        : cell?.status === 'overdue' ? 'overdue'
        : 'open';
      return { id: m.member_id, code: m.member_code, name: m.member_name, cell, owes, month };
    })
    .sort((a, b) => rank(a) - rank(b) || (b.owes > a.owes ? 1 : b.owes < a.owes ? -1 : 0) || a.code.localeCompare(b.code));

  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, rows.filter((r) => inFilter(r, f)).length])) as Record<Filter, number>;
  const paidCount = rows.filter((r) => r.month === 'paid').length;

  return (
    <Card className="min-w-0 px-5 pb-3 pt-5 sm:px-6">
      <Tabs.Root value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[1.0625rem] font-bold">{t('adminDash.membersTitle')}</h2>
            <p className="text-[0.8125rem] text-muted">
              {matrix ? t('adminDash.membersSub', { period: fmtPeriod(period), paid: formatCount(paidCount), total: formatCount(counts.all) }) : fmtPeriod(period)}
            </p>
          </div>
          <Tabs.List aria-label={t('adminDash.filterLabel')} className="flex gap-0.5 rounded-xl bg-soft p-1 text-[0.8125rem]">
            {FILTERS.map(([value, key]) => (
              <Tabs.Trigger
                key={value}
                value={value}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-ink2 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-card data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=active]:shadow-card"
              >
                {t(key)}
                {matrix && <span className="text-xs text-muted tabular-nums">{formatCount(counts[value])}</span>}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </div>

        {FILTERS.map(([value]) => (
          <Tabs.Content key={value} value={value} className="outline-none">
            {!matrix ? (
              <div className="space-y-2 py-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : (
              <StatusTable rows={rows.filter((r) => inFilter(r, value))} />
            )}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </Card>
  );
}

/** Four columns from `sm` up; on a phone a row is the name (with paid / due under it) and the status pill. */
const COLS = 'sm:grid sm:grid-cols-[minmax(0,1.7fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_7.5rem] items-center gap-3';

function StatusTable({ rows }: { rows: StatusRow[] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted">{t('adminDash.filterEmpty')}</p>;
  const shown = rows.slice(0, TABLE_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <div>
      <div role="table">
        <div role="row" className={`${COLS} hidden min-h-10 border-b border-border text-xs font-semibold text-muted`}>
          <span role="columnheader">{t('adminDash.colMember')}</span>
          <span role="columnheader">{t('adminDash.colDue')}</span>
          <span role="columnheader">{t('adminDash.colPaid')}</span>
          <span role="columnheader">{t('adminDash.colStatus')}</span>
        </div>
        {shown.map((r) => {
          const due = BigInt(r.cell?.due_paisa ?? '0');
          const paid = BigInt(r.cell?.paid_paisa ?? '0');
          const pct = Math.min(percent(paid, due), 100);
          const bar = r.month === 'pending' ? 'bg-warn' : r.month === 'overdue' ? 'bg-bad' : 'bg-primary';
          return (
            <div role="row" key={r.id} className={`${COLS} flex min-h-[3.5rem] border-b border-border py-2 last:border-b-0`}>
              <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-soft text-[0.6875rem] font-bold text-ink2">{r.code}</span>
                <div className="min-w-0">
                  <p className="truncate text-[0.9375rem] font-semibold">{r.name}</p>
                  {r.cell && <p className="truncate text-xs text-muted tabular-nums sm:hidden">{taka(paid)} / {taka(due)}</p>}
                  {r.owes > 0n && <p className="truncate text-xs text-bad">{t('adminDash.owesTotal', { amount: taka(r.owes) })}</p>}
                </div>
              </div>
              <span role="cell" className="hidden text-[0.9375rem] tabular-nums sm:block">{r.cell ? taka(due) : '—'}</span>
              <div role="cell" className="hidden min-w-0 sm:block">
                <p className="text-[0.8125rem] text-muted tabular-nums">{r.cell ? taka(paid) : '—'}</p>
                {r.cell && due > 0n && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-soft">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <span role="cell" className="shrink-0">
                <StatusPill status={r.month === 'pending' ? 'pending' : r.cell?.status ?? 'none'} />
              </span>
            </div>
          );
        })}
      </div>
      <Link to="/admin/matrix" className="flex min-h-11 items-center gap-1 text-[0.8125rem] font-semibold text-primary hover:underline">
        {hidden > 0 ? t('adminDash.moreMembers', { n: formatCount(hidden) }) : t('adminDash.openMatrix')}
        <Icon d={ICONS.chevron} size={14} sw={2.2} />
      </Link>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function TaskRow({ to, tone, icon, title, sub }: { to: string; tone: string; icon: string; title: string; sub: string }) {
  return (
    <li>
      <Link to={to} className="-mx-2 flex min-h-[3.75rem] items-center gap-3 rounded-xl px-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        <Chip tone={tone} d={icon} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-xs text-muted">{sub}</p>
        </div>
        <span className="text-muted"><Icon d={ICONS.chevron} size={16} /></span>
      </Link>
    </li>
  );
}

/** Only what needs a person today. Nothing waiting is a calm "all caught up", not a row of zeros. */
function Tasks({ pending, approvals, objections, votes }: {
  pending?: Page<PaymentRow>;
  approvals?: Page<ApprovalRow>;
  objections?: Page<ObjectionRow>;
  votes?: Page<ProposalSummary>;
}) {
  const { t } = useTranslation();
  const loaded = pending && approvals && objections && votes;
  const n = (page: Page<unknown>) => `${formatCount(page.items.length)}${page.next_cursor ? '+' : ''}`;
  const oldest = (dates: string[]) => dates.reduce((o, d) => (d < o ? d : o));

  const rows: ReactNode[] = [];
  if (pending?.items.length) {
    rows.push(
      <TaskRow key="pay" to="/admin/payments" tone="bg-warn-bg text-warn" icon={ICONS.wallet}
        title={t('adminDash.taskPayments', { n: n(pending) })}
        sub={t('adminDash.taskPaymentsSub', { date: fmtInstant(oldest(pending.items.map((p) => p.submitted_at))) })} />,
    );
  }
  if (approvals?.items.length) {
    rows.push(
      <TaskRow key="appr" to="/admin/payments?tab=approvals" tone="bg-blue-bg text-blue" icon={ICONS.undo}
        title={t('adminDash.taskApprovals', { n: n(approvals) })} sub={t('adminDash.taskApprovalsSub')} />,
    );
  }
  if (objections?.items.length) {
    rows.push(
      <TaskRow key="obj" to="/admin/ledger" tone="bg-bad-bg text-bad" icon={ICONS.flag}
        title={t('adminDash.taskObjections', { n: n(objections) })} sub={t('adminDash.taskObjectionsSub')} />,
    );
  }
  for (const v of [...(votes?.items ?? [])].sort((a, b) => (a.closes_at ?? '').localeCompare(b.closes_at ?? '')).slice(0, 3)) {
    const date = v.closes_at ? fmtInstant(v.closes_at) : '—';
    rows.push(
      <TaskRow key={v.id} to="/admin/proposals" tone="bg-primary-soft text-primary" icon={ICONS.vote} title={v.title}
        sub={v.voted_count !== undefined
          ? t('adminDash.taskVoteSubCount', { date, voted: formatCount(v.voted_count), eligible: formatCount(v.eligible_count) })
          : t('adminDash.taskVoteSub', { date })} />,
    );
  }

  return (
    <Card className="px-5 pb-3 pt-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[1.0625rem] font-bold">{t('adminDash.todo')}</h2>
        {loaded && rows.length > 0 && <span className="rounded-full bg-soft px-2 py-0.5 text-xs font-bold text-ink2 tabular-nums">{formatCount(rows.length)}</span>}
      </div>
      {!loaded ? (
        <div className="space-y-2 pb-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 py-4">
          <Chip tone="bg-ok-bg text-ok" d={ICONS.check} />
          <div>
            <p className="text-sm font-semibold">{t('adminDash.tasksDone')}</p>
            <p className="text-xs text-muted">{t('adminDash.tasksDoneSub')}</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border">{rows}</ul>
      )}
    </Card>
  );
}

type Health = 'ok' | 'warn' | 'bad' | 'unknown';
const HEALTH: Record<Health, [string, string]> = {
  ok: ['text-ok', '✓'],
  warn: ['text-warn', '◔'],
  bad: ['text-bad', '!'],
  unknown: ['text-muted', '–'],
};

function Safety({ system, systemFailed, verify, today }: { system?: SystemStatus; systemFailed: boolean; verify?: { ok: boolean; count: number }; today: string }) {
  const { t } = useTranslation();
  const ago = (date: string) => {
    const days = daysBetween(date, today);
    return days <= 0 ? t('adminDash.todayWord') : t('adminDash.daysAgo', { n: formatCount(days) });
  };
  const run = (r: { ok: boolean; finished?: string } | null | undefined): [Health, string] =>
    !r ? ['unknown', t('systemStatus.unknown')] : [r.ok ? 'ok' : 'bad', r.finished ? fmtInstant(r.finished) : r.ok ? t('systemStatus.ok') : t('systemStatus.problem')];
  const offlineDays = system?.offline_copy ? daysBetween(system.offline_copy.on, today) : null;

  const lines: Array<[string, Health, string]> = [
    [t('adminDash.lastBackup'), ...run(system?.backup)],
    [t('adminDash.restoreTest'), ...run(system?.restore_test)],
    [
      t('systemStatus.ledger'),
      !verify ? 'unknown' : verify.ok ? 'ok' : 'bad',
      !verify ? t('systemStatus.unknown') : verify.ok ? t('adminDash.ledgerEntries', { n: formatCount(verify.count) }) : t('adminDash.ledgerBroken'),
    ],
    [
      t('systemStatus.offline'),
      offlineDays === null ? 'unknown' : offlineDays > OFFLINE_COPY_MAX_DAYS ? 'warn' : 'ok',
      system?.offline_copy ? ago(system.offline_copy.on) : t('systemStatus.unknown'),
    ],
  ];

  return (
    <Card className="px-5 pb-2 pt-5">
      <div className="mb-2 flex items-center gap-2.5">
        <Chip tone="bg-ok-bg text-ok" d={ICONS.shield} size={32} iconSize={18} />
        <h2 className="text-[1.0625rem] font-bold">{t('adminDash.safetyTitle')}</h2>
      </div>
      {!system && !systemFailed ? (
        <div className="space-y-2 pb-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
      ) : (
        <dl>
          {lines.map(([label, health, text]) => (
            <div key={label} className="flex min-h-11 items-center justify-between gap-3 border-t border-border text-sm">
              <dt className="text-ink2">{label}</dt>
              <dd className={`text-right font-semibold ${HEALTH[health][0]}`}>
                <span aria-hidden="true">{HEALTH[health][1]} </span>
                {text}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Link to="/admin/system" className="flex min-h-11 items-center gap-1 border-t border-border text-[0.8125rem] font-semibold text-primary hover:underline">
        {t('adminDash.safetyMore')}
        <Icon d={ICONS.chevron} size={14} sw={2.2} />
      </Link>
    </Card>
  );
}
