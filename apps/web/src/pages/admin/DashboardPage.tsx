import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
      <h1 className="text-2xl font-semibold">{t('admin.dashboard')}</h1>
      {failed?.error && <LoadError error={failed.error} onRetry={() => void failed.refetch()} />}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.netAssets')} value={accounts.data ? taka(interimNetAssets(accounts.data.items)) : null} hint={t('adminDash.netAssetsHint')} />
        <Stat label={t('admin.collectedThisMonth')} value={totals ? t('adminDash.collectedOf', { collected: taka(totals.paid_paisa), expected: taka(totals.due_paisa) }) : null} />
        <Stat label={t('admin.overdueMembers')} value={members.data ? formatCount(overdue.length) : null} />
        <Stat label={t('admin.pendingPayments')} value={pending.data ? count(pending.data) : null} to="/admin/payments" />
        <Stat label={t('adminDash.openApprovals')} value={approvals.data ? count(approvals.data) : null} to="/admin/payments?tab=approvals" />
        <Stat label={t('adminDash.openObjections')} value={objections.data ? count(objections.data) : null} to="/admin/ledger" />
        <Stat label={t('adminDash.charityBalance')} value={accounts.data ? taka(charityBalance(accounts.data.items)) : null} />
        <Stat
          label={verify.data?.ok === false ? t('adminDash.ledgerBad') : t('adminDash.ledgerOk')}
          value={verify.data ? t('adminDash.ledgerCount', { n: formatCount(verify.data.count) }) : null}
          tone={verify.data?.ok === false ? 'bad' : 'ok'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">{t('adminDash.pendingList')}</h2>
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

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">{t('adminDash.overdueList')}</h2>
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

function Stat({ label, value, hint, to, tone }: { label: string; value: string | null; hint?: string; to?: string; tone?: 'ok' | 'bad' }) {
  const body = (
    <div className="h-full rounded-lg border border-border bg-card p-4">
      <p className="text-muted">{label}</p>
      {value === null ? <Skeleton className="mt-2 h-7 w-28" /> : <p className={`mt-1 text-xl font-semibold ${tone === 'bad' ? 'text-bad' : ''}`}>{value}</p>}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}
