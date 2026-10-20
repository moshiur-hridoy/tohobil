import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { taka } from '../../lib/money';
import { charityBalance, interimNetAssets } from '../../lib/nav';
import type { AccountBalance, DueRow, MemberRow } from '../../lib/types';

export function HomePage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const accounts = useQuery({ queryKey: ['balances'], queryFn: () => api<{ items: AccountBalance[] }>('/accounts/balances') });
  const myDues = useQuery({
    queryKey: ['dues', 'me', me?.member_id],
    enabled: !!me,
    queryFn: () => api<{ items: DueRow[] }>(`/dues?member_id=${me?.member_id}&limit=60`),
  });

  const mine = members.data?.items.find((m) => m.id === me?.member_id);
  const principal = BigInt(mine?.outstanding_principal_paisa ?? '0');
  const fines = BigInt(mine?.outstanding_fines_paisa ?? '0');
  const owed = principal + fines;
  const nextDue = myDues.data?.items
    .filter((d) => BigInt(d.outstanding_paisa) > 0n)
    .map((d) => d.due_date)
    .sort()[0];

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['members'] }), qc.invalidateQueries({ queryKey: ['balances'] }), qc.invalidateQueries({ queryKey: ['dues'] })]);

  if (members.error) return <div className="p-4"><LoadError error={members.error} onRetry={() => void members.refetch()} /></div>;

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="space-y-4 p-4">
        {/* Outstanding card */}
        <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="home-outstanding">
          <h2 id="home-outstanding" className="mb-1 text-muted">{t('home.myOutstanding')}</h2>
          {!mine ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <>
              <p className={`text-2xl font-bold ${owed > 0n ? 'text-bad' : 'text-ok'}`}>{taka(owed)}</p>
              {owed === 0n ? (
                <p className="mt-1 text-muted">{t('home.outstandingNone')}</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-x-4">
                  <span>{t('home.principal')}: {taka(principal)}</span>
                  <span>{t('home.fines')}: {taka(fines)}</span>
                </div>
              )}
              {nextDue && <p className="mt-1 text-muted">{t('home.nextDueOn', { date: fmtDate(nextDue) })}</p>}
              {mine.under_verification && (
                <p role="status" className="mt-2 rounded-md bg-primary-soft p-2 text-warn">
                  <strong>{t('home.underVerification')}.</strong> {t('home.underVerificationHint')}
                </p>
              )}
              <Link to="/pay" className="mt-3 flex h-12 w-full items-center justify-center rounded-md bg-primary font-medium text-primary-foreground">
                {t('home.payNow')}
              </Link>
            </>
          )}
        </section>

        {/* Fund summary */}
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-1 text-muted">{t('home.fundNetAssets')}</h2>
          {accounts.data ? (
            <>
              <p className="text-xl font-semibold">{taka(interimNetAssets(accounts.data.items))}</p>
              <p className="text-sm text-muted">{t('home.netAssetsHint')}</p>
            </>
          ) : (
            <Skeleton className="h-7 w-32" />
          )}
          <p className="mt-2 text-muted">{t('home.myCapital')}: {mine ? taka(mine.capital_paisa) : '…'}</p>
        </section>

        {/* Charity balance (18.2): fines and riba are donated at year end, never fund income */}
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-1 text-muted">{t('home.charityToDonate')}</h2>
          <p className="text-lg font-semibold text-warn">{accounts.data ? taka(charityBalance(accounts.data.items)) : '…'}</p>
        </section>

        {/* Everyone's standing this month */}
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 font-semibold">{t('home.everyoneThisMonth')}</h2>
          {!members.data ? (
            <ListSkeleton rows={4} />
          ) : (
            <ul className="divide-y divide-border">
              {members.data.items
                .filter((m) => m.current_period_status !== null)
                .map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                    <span>{m.full_name}</span>
                    {m.under_verification && m.current_period_status !== 'paid' && m.current_period_status !== 'paid_late' ? (
                      <StatusPill status="pending" />
                    ) : (
                      <StatusPill status={m.current_period_status as string} />
                    )}
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>
    </PullToRefresh>
  );
}
