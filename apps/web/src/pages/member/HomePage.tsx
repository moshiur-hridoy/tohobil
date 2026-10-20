import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { LoadError } from '../../components/StateViews';
import { Chip, Icon } from '../../components/ui';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { taka } from '../../lib/money';
import { charityBalance, interimNetAssets } from '../../lib/nav';
import { useCountdown } from '../../lib/countdown';
import type { AccountBalance, DueRow, MemberRow, ProposalSummary } from '../../lib/types';

const AVATAR = ['bg-primary-soft text-primary', 'bg-blue-bg text-blue', 'bg-vio-bg text-vio', 'bg-warn-bg text-warn'];

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

  const proposals = useQuery({
    queryKey: ['proposals', 'member'],
    queryFn: () => api<{ items: ProposalSummary[]; next_cursor: string | null }>('/proposals?limit=200'),
  });
  const openVotes = proposals.data?.items.filter((p) => p.status === 'open') ?? [];
  const firstOpen = openVotes[0];
  const remaining = useCountdown(firstOpen?.closes_at ?? null);

  const mine = members.data?.items.find((m) => m.id === me?.member_id);
  const principal = BigInt(mine?.outstanding_principal_paisa ?? '0');
  const fines = BigInt(mine?.outstanding_fines_paisa ?? '0');
  const owed = principal + fines;
  const nextDue = myDues.data?.items
    .filter((d) => BigInt(d.outstanding_paisa) > 0n)
    .map((d) => d.due_date)
    .sort()[0];

  const standing = (members.data?.items ?? []).filter((m) => m.current_period_status !== null);
  const paidCount = standing.filter((m) => m.current_period_status === 'paid' || m.current_period_status === 'paid_late').length;

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['members'] }), qc.invalidateQueries({ queryKey: ['balances'] }), qc.invalidateQueries({ queryKey: ['dues'] })]);

  if (members.error) return <div className="p-4"><LoadError error={members.error} onRetry={() => void members.refetch()} /></div>;

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        {/* Outstanding hero card */}
        <section className="relative overflow-hidden rounded-3xl bg-primary-deep p-5 text-white" aria-labelledby="home-outstanding">
          <svg aria-hidden="true" width="200" height="200" viewBox="0 0 200 200" className="absolute -right-[50px] -top-[60px] opacity-[0.14]">
            <circle cx="100" cy="100" r="96" fill="none" stroke="#fff" strokeWidth="2" />
            <circle cx="100" cy="100" r="66" fill="none" stroke="#fff" strokeWidth="2" />
            <circle cx="100" cy="100" r="36" fill="none" stroke="#fff" strokeWidth="2" />
          </svg>
          <div className="relative">
            <h2 id="home-outstanding" className="flex items-center gap-2.5 text-sm font-normal">
              <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-white/[0.16]">
                <Icon d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 10h18 M16 14.5h2" size={18} />
              </span>
              {t('home.myOutstanding')}
            </h2>
            {!mine ? (
              <Skeleton className="mt-3 h-10 w-40" />
            ) : (
              <>
                <p className="mt-2.5 text-[2.625rem] font-bold leading-[1.15]">{taka(owed)}</p>
                {owed === 0n ? (
                  <p className="mt-2.5 text-sm">{t('home.outstandingNone')}</p>
                ) : (
                  <div className="mt-2.5 flex flex-wrap gap-2 text-[0.8125rem]">
                    <span className="rounded-full bg-white/[0.16] px-2.5 py-1">{t('home.fines')} {taka(fines)}</span>
                    {nextDue && <span className="rounded-full bg-white/[0.16] px-2.5 py-1">{t('home.nextDueOn', { date: fmtDate(nextDue) })}</span>}
                  </div>
                )}
                {principal > 0n && fines > 0n && (
                  <p className="mt-2 text-[0.8125rem]">{t('home.principal')}: {taka(principal)}</p>
                )}
                {mine.under_verification && (
                  <p role="status" className="mt-3 rounded-xl bg-warn-bg p-2.5 text-sm text-warn">
                    <strong>{t('home.underVerification')}.</strong> {t('home.underVerificationHint')}
                  </p>
                )}
                <Link to="/pay" className="mt-[18px] flex h-[54px] w-full items-center justify-center gap-2 rounded-2xl bg-white text-[1.0625rem] font-bold text-primary">
                  {t('home.payNow')}
                  <Icon d="M5 12h14 M13 6l6 6-6 6" size={20} sw={2} />
                </Link>
              </>
            )}
          </div>
        </section>

        {/* Fund summary tiles */}
        <section className="grid grid-cols-2 gap-3">
          <div className="rounded-[18px] border border-border bg-card p-3.5">
            <Chip tone="bg-primary-soft text-primary" d="M3 17l6-6 4 4 8-8 M15 7h6v6" />
            <h2 className="mt-2.5 text-[0.8125rem] font-normal text-muted">{t('home.fundNetAssets')}</h2>
            {accounts.data ? (
              <p className="mt-0.5 text-[1.3125rem] font-bold">{taka(interimNetAssets(accounts.data.items))}</p>
            ) : (
              <Skeleton className="mt-1 h-7 w-28" />
            )}
          </div>
          <div className="rounded-[18px] border border-border bg-card p-3.5">
            <Chip tone="bg-blue-bg text-blue" d="M12 3l9 5-9 5-9-5z M3 13l9 5 9-5" />
            <h2 className="mt-2.5 text-[0.8125rem] font-normal text-muted">{t('home.myCapital')}</h2>
            <p className="mt-0.5 text-[1.3125rem] font-bold">{mine ? taka(mine.capital_paisa) : '…'}</p>
          </div>
          {/* Charity balance (18.2): fines and riba are donated at year end, never fund income */}
          <div className="col-span-2 flex items-center gap-3 rounded-[18px] border border-border bg-card px-3.5 py-3">
            <Chip tone="bg-vio-bg text-vio" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
            <h2 className="flex-1 text-[0.8125rem] font-normal text-muted">{t('home.charityToDonate')}</h2>
            <p className="text-[1.1875rem] font-bold">{accounts.data ? taka(charityBalance(accounts.data.items)) : '…'}</p>
          </div>
        </section>
        <p className="px-1 text-xs text-muted">{t('home.netAssetsHint')}</p>

        {openVotes.length > 0 && firstOpen && (
          <Link to="/votes" className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-3.5 text-foreground">
            <Chip tone="bg-warn-bg text-warn" size={40} iconSize={22} d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z M9 12l2 2 4-4" />
            <div className="min-w-0 flex-1">
              <div className="text-base font-bold">{t('votes.openCount', { count: openVotes.length })}</div>
              <div className="truncate text-[0.8125rem] text-ink2">{firstOpen.title}{remaining ? ` · ${remaining}` : ''}</div>
            </div>
            <span className="text-muted"><Icon d="M9 5l7 7-7 7" sw={2} /></span>
          </Link>
        )}

        {/* Everyone's standing this month */}
        <section className="overflow-hidden rounded-[18px] border border-border bg-card">
          <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
            <Chip tone="bg-primary-soft text-primary" d="M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M20 20v-1a4 4 0 0 0-3-3.8 M16 4.2a3.5 3.5 0 0 1 0 6.6" />
            <h2 className="flex-1 text-base font-bold">{t('home.everyoneThisMonth')}</h2>
            {members.data && <span className="text-sm font-bold text-primary">{paidCount}/{standing.length}</span>}
          </div>
          {!members.data ? (
            <div className="px-4 pb-4"><ListSkeleton rows={4} /></div>
          ) : (
            <>
              <div className="mx-4 mb-2 h-1.5 overflow-hidden rounded-full bg-border">
                <div className="h-full bg-primary" style={{ width: `${standing.length ? (paidCount / standing.length) * 100 : 0}%` }} />
              </div>
              <ul>
                {standing.map((m, i) => {
                  const isMe = m.id === me?.member_id;
                  const verifying = m.under_verification && m.current_period_status !== 'paid' && m.current_period_status !== 'paid_late';
                  return (
                    <li key={m.id} className={`flex min-h-[50px] items-center gap-3 border-t border-border px-4 ${isMe ? 'bg-primary-soft' : ''}`}>
                      <span className={`grid h-[34px] w-[34px] place-items-center rounded-full text-sm font-bold ${isMe ? 'bg-primary text-primary-foreground' : AVATAR[i % AVATAR.length]}`}>
                        {m.full_name.trim().charAt(0)}
                      </span>
                      <span className={`flex-1 text-[0.9375rem] ${isMe ? 'font-bold' : 'font-medium'}`}>{m.full_name}</span>
                      <StatusPill status={verifying ? 'pending' : (m.current_period_status as string)} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>
    </PullToRefresh>
  );
}
