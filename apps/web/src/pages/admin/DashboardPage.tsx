import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip } from '../../components/ui';
import { Skeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';
import { charityBalance, interimNetAssets } from '../../lib/nav';
import type { AccountBalance, ApprovalRow, MatrixResponse, MemberRow, ObjectionRow, Page, PaymentRow } from '../../lib/types';

const ALL = 200;

/** Every number here is computed from the API; nothing on this page is typed in (spec 19.5). */
export function AdminDashboard() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const period = todayDhaka().slice(0, 7);

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const accounts = useQuery({ queryKey: ['balances'], queryFn: () => api<{ items: AccountBalance[] }>('/accounts/balances') });
  const matrix = useQuery({ queryKey: ['matrix', period, period], queryFn: () => api<MatrixResponse>(`/matrix?from=${period}&to=${period}`) });
  const pending = useQuery({ queryKey: ['payments', 'pending'], queryFn: () => api<Page<PaymentRow>>(`/payments?status=pending&limit=${ALL}`) });
  const approvals = useQuery({ queryKey: ['approvals', 'pending'], queryFn: () => api<Page<ApprovalRow>>(`/approvals?status=pending&limit=${ALL}`) });
  const objections = useQuery({ queryKey: ['objections', 'open'], queryFn: () => api<Page<ObjectionRow>>(`/objections?status=open&limit=${ALL}`) });
  const verify = useQuery({ queryKey: ['ledger-verify'], queryFn: () => api<{ ok: boolean; count: number }>('/ledger/verify'), staleTime: 60_000 });

  const failed = [members, accounts, matrix, pending].find((q) => q.error);
  const totals = matrix.data?.totals_by_period[period];
  const overdue = members.data?.items.filter((m) => m.overdue_count > 0) ?? [];
  const more = (page: Page<unknown> | undefined) => (page?.next_cursor ? '+' : '');
  const count = (page: Page<unknown> | undefined) => (page ? `${formatCount(page.items.length)}${more(page)}` : '…');

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">{t('admin.dashboard')}</h1>
      {failed?.error && <LoadError error={failed.error} onRetry={() => void failed.refetch()} />}

      {/* Net assets hero (design: Cashier · Dashboard) */}
      <section className="rounded-[20px] border border-border bg-card p-6 shadow-card">
        <p className="text-sm font-semibold text-ink2">{t('admin.netAssets')}</p>
        {accounts.data ? (
          <p className="mt-1.5 text-[2.5rem] font-bold leading-tight tracking-tight">{taka(interimNetAssets(accounts.data.items))}</p>
        ) : (
          <Skeleton className="mt-2 h-10 w-56" />
        )}
        <p className="mt-2 text-sm text-muted">{t('adminDash.netAssetsHint')}</p>
      </section>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.collectedThisMonth')} value={totals ? t('adminDash.collectedOf', { collected: taka(totals.paid_paisa), expected: taka(totals.due_paisa) }) : null} tone="ok" icon="M3 17l6-6 4 4 8-8 M15 7h6v6" />
        <Stat label={t('admin.overdueMembers')} value={members.data ? formatCount(overdue.length) : null} tone={overdue.length > 0 ? 'bad' : 'ok'} icon="M12 8v5 M12 16v.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" />
        <Stat label={t('admin.pendingPayments')} value={pending.data ? count(pending.data) : null} to="/admin/payments" tone="warn" icon="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2" />
        <Stat label={t('adminDash.openApprovals')} value={approvals.data ? count(approvals.data) : null} to="/admin/payments?tab=approvals" tone="blue" icon="M4 4h16v16H4z M9 12l2 2 4-4" />
        <Stat label={t('adminDash.openObjections')} value={objections.data ? count(objections.data) : null} to="/admin/ledger" tone="warn" icon="M12 3l10 18H2z M12 10v5 M12 18v.01" />
        <Stat label={t('adminDash.charityBalance')} value={accounts.data ? taka(charityBalance(accounts.data.items)) : null} tone="vio" icon="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
        <Stat
          label={verify.data?.ok === false ? t('adminDash.ledgerBad') : t('adminDash.ledgerOk')}
          value={verify.data ? t('adminDash.ledgerCount', { n: formatCount(verify.data.count) }) : null}
          tone={verify.data?.ok === false ? 'bad' : 'ok'}
          icon="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
          <h2 className="mb-2 text-[1.0625rem] font-bold">{t('adminDash.pendingList')}</h2>
          {!pending.data ? (
            <Skeleton className="h-16 w-full" />
          ) : pending.data.items.length === 0 ? (
            <p className="text-muted">{t('paymentsPage.empty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {pending.data.items.slice(0, 6).map((p) => (
                <li key={p.id} className="flex justify-between gap-3 py-2">
                  <span>{p.member_code} {p.member_name}</span>
                  <span className="font-medium">{taka(p.amount_paisa)}</span>
                </li>
              ))}
            </ul>
          )}
          {me?.roles.includes('cashier') && (
            <Link to="/admin/payments" className="mt-3 inline-block text-primary underline">{t('home.reachCashier')}</Link>
          )}
        </section>

        <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
          <h2 className="mb-2 text-[1.0625rem] font-bold">{t('adminDash.overdueList')}</h2>
          {!members.data ? (
            <Skeleton className="h-16 w-full" />
          ) : overdue.length === 0 ? (
            <p className="text-muted">{t('adminDash.noOverdue')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {overdue.map((m) => (
                <li key={m.id} className="flex justify-between gap-3 py-2">
                  <span>{m.code} {m.full_name}</span>
                  <span className="font-medium text-bad">{taka(BigInt(m.outstanding_principal_paisa) + BigInt(m.outstanding_fines_paisa))}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="text-sm text-muted">{t('adminDash.backupLater')}</p>
    </div>
  );
}

const TONES = {
  ok: ['bg-ok-bg text-ok', ''],
  bad: ['bg-bad-bg text-bad', 'text-bad'],
  warn: ['bg-warn-bg text-warn', ''],
  blue: ['bg-blue-bg text-blue', ''],
  vio: ['bg-vio-bg text-vio', ''],
} as const;

function Stat({ label, value, to, tone = 'ok', icon }: { label: string; value: string | null; to?: string; tone?: keyof typeof TONES; icon: string }) {
  const [chip, text] = TONES[tone];
  const body = (
    <div className="h-full rounded-[18px] border border-border bg-card px-[18px] py-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <Chip tone={chip} d={icon} />
        <p className="text-sm text-muted">{label}</p>
      </div>
      {value === null ? <Skeleton className="mt-3 h-7 w-28" /> : <p className={`mt-3 text-2xl font-bold ${text}`}>{value}</p>}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}
