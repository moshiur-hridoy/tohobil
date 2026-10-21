import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { addMonths } from '@barakah/shared';
import { useTranslation } from 'react-i18next';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { LoadError } from '../../components/StateViews';
import { Chip, Icon } from '../../components/ui';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtClock, fmtDate, fmtPeriod, todayDhaka } from '../../lib/dates';
import { arrearsOf, taka } from '../../lib/money';
import { charityBalance, interimNetAssets } from '../../lib/nav';
import { useCountdown } from '../../lib/countdown';
import type { AccountBalance, DueRow, MatrixResponse, MeetingRow, MemberRow, ProposalSummary } from '../../lib/types';

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
  const meeting = useQuery({ queryKey: ['meetings', 'next'], queryFn: () => api<{ meeting: MeetingRow | null }>('/meetings/next') });
  const nextMeeting = meeting.data?.meeting;
  const remaining = useCountdown(firstOpen?.closes_at ?? null);

  const mine = members.data?.items.find((m) => m.id === me?.member_id);
  // Only dues past their due date count as owed; dues generated ahead of time are shown as the next due date.
  const principal = BigInt(mine?.overdue_paisa ?? '0');
  const fines = BigInt(mine?.outstanding_fines_paisa ?? '0');
  const owed = principal + fines;
  const nextDue = myDues.data?.items
    .filter((d) => BigInt(d.outstanding_paisa) > 0n)
    .map((d) => d.due_date)
    .sort()[0];

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['members'] }),
      qc.invalidateQueries({ queryKey: ['balances'] }),
      qc.invalidateQueries({ queryKey: ['dues'] }),
      qc.invalidateQueries({ queryKey: ['matrix'] }),
      qc.invalidateQueries({ queryKey: ['meetings', 'next'] }),
    ]);

  if (members.error) return <div className="p-4"><LoadError error={members.error} onRetry={() => void members.refetch()} /></div>;

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        {/* Outstanding hero card */}
        <section className="relative overflow-hidden rounded-3xl bg-hero p-5 text-on-hero" aria-labelledby="home-outstanding">
          <svg aria-hidden="true" width="200" height="200" viewBox="0 0 200 200" className="absolute -right-[50px] -top-[60px] opacity-[0.14]">
            <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="100" cy="100" r="66" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="100" cy="100" r="36" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div className="relative">
            <h2 id="home-outstanding" className="flex items-center gap-2.5 text-sm font-normal">
              <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-hero-icon">
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
                  <>
                    <p className="mt-2.5 text-sm">{t('home.outstandingNone')}</p>
                    {nextDue && (
                      <div className="mt-2.5 flex flex-wrap gap-2 text-[0.8125rem]">
                        <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.nextDueOn', { date: fmtDate(nextDue) })}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-2.5 flex flex-wrap gap-2 text-[0.8125rem]">
                    <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.fines')} {taka(fines)}</span>
                    {nextDue && <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.nextDueOn', { date: fmtDate(nextDue) })}</span>}
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
                <Link to="/pay" className="mt-[18px] flex h-[54px] w-full items-center justify-center gap-2 rounded-2xl bg-hero-action text-[1.0625rem] font-bold text-on-hero-action">
                  {owed === 0n ? t('home.payAdvance') : t('home.payNow')}
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

        {nextMeeting?.date && nextMeeting.time && (
          <section className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-3.5" aria-labelledby="home-meeting">
            <Chip tone="bg-blue-bg text-blue" size={40} iconSize={22} d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h3" />
            <div className="min-w-0 flex-1">
              <h2 id="home-meeting" className="text-[0.8125rem] font-normal text-muted">{t('meetings.nextMeeting')}</h2>
              <p className="text-base font-bold">{fmtDate(nextMeeting.date)} · {fmtClock(t, nextMeeting.time)}</p>
              {nextMeeting.notes && <p className="truncate text-[0.8125rem] text-ink2">{nextMeeting.notes}</p>}
            </div>
            {nextMeeting.link && (
              <a href={nextMeeting.link} target="_blank" rel="noreferrer" className="shrink-0 rounded-xl bg-primary px-3.5 py-2.5 text-sm font-semibold text-primary-foreground">
                {t('meetings.join')}
              </a>
            )}
          </section>
        )}

        <EveryoneStanding members={members.data?.items} />
      </div>
    </PullToRefresh>
  );
}

/** The whole fund term is three years (the matrix's limit too), so one request covers every month and switching is instant. */
const HISTORY_MONTHS = 36;

/**
 * Everyone's standing for any month (the matrix is readable by every member), plus what each member
 * owes in total right now: overdue dues and unpaid fines, the same figure as the hero card.
 */
function EveryoneStanding({ members }: { members?: MemberRow[] }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const current = todayDhaka().slice(0, 7);
  // Up to December, so months already paid in advance can be seen.
  const last = `${current.slice(0, 4)}-12`;
  const from = addMonths(last, -(HISTORY_MONTHS - 1));
  const [period, setPeriod] = useState(current);

  const matrix = useQuery({ queryKey: ['matrix', from, last], queryFn: () => api<MatrixResponse>(`/matrix?from=${from}&to=${last}`) });

  // Months before the fund's first due are not offered.
  const first = matrix.data?.periods.find((p) => matrix.data?.members.some((m) => m.cells[p])) ?? current;
  const owedById = new Map(members?.map((m) => [m.id, arrearsOf(m)]));
  const rows = (matrix.data?.members ?? []).filter((m) => m.cells[period]);
  const paidCount = rows.filter((m) => {
    const s = m.cells[period]?.status;
    return s === 'paid' || s === 'paid_late';
  }).length;
  const groupOwed = [...owedById.values()].reduce((a, b) => a + b, 0n);

  const arrow = (d: string, label: string, to: string, disabled: boolean) => (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => setPeriod(to)}
      className="grid h-9 w-9 place-items-center rounded-xl border border-border text-foreground disabled:opacity-30"
    >
      <Icon d={d} size={18} sw={2} />
    </button>
  );

  return (
    <section className="overflow-hidden rounded-[18px] border border-border bg-card" aria-labelledby="home-everyone">
      <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
        <Chip tone="bg-primary-soft text-primary" d="M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M20 20v-1a4 4 0 0 0-3-3.8 M16 4.2a3.5 3.5 0 0 1 0 6.6" />
        <h2 id="home-everyone" className="flex-1 text-base font-bold">{t('home.everyoneInMonth')}</h2>
        {matrix.data && rows.length > 0 && <span className="text-sm font-bold text-primary">{paidCount}/{rows.length}</span>}
      </div>

      {/* Month switcher: from the fund's first month up to December of this year */}
      <div className="mx-4 mb-3 flex items-center gap-2">
        {arrow('M15 5l-7 7 7 7', t('home.prevMonth'), addMonths(period, -1), !matrix.data || period <= first)}
        <p className="flex-1 text-center text-[0.9375rem] font-bold" aria-live="polite">{fmtPeriod(period)}</p>
        {arrow('M9 5l7 7-7 7', t('home.nextMonth'), addMonths(period, 1), period >= last)}
      </div>

      {matrix.error ? (
        <div className="px-4 pb-4"><LoadError error={matrix.error} onRetry={() => void matrix.refetch()} /></div>
      ) : !matrix.data ? (
        <div className="px-4 pb-4"><ListSkeleton rows={4} /></div>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-5 pt-2 text-center text-sm text-muted">{t(period > current ? 'home.duesNotYetCreated' : 'home.noDuesInMonth')}</p>
      ) : (
        <>
          <div className="mx-4 mb-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div className="h-full bg-primary" style={{ width: `${(paidCount / rows.length) * 100}%` }} />
          </div>
          <ul>
            {rows.map((m, i) => {
              const cell = m.cells[period];
              const isMe = m.member_id === me?.member_id;
              const owed = owedById.get(m.member_id);
              const settled = cell?.status === 'paid' || cell?.status === 'paid_late';
              return (
                <li key={m.member_id} className={`flex min-h-[58px] items-center gap-3 border-t border-border px-4 py-2 ${isMe ? 'bg-primary-soft' : ''}`}>
                  <span className={`grid h-[34px] w-[34px] flex-none place-items-center rounded-full text-sm font-bold ${isMe ? 'bg-primary text-primary-foreground' : AVATAR[i % AVATAR.length]}`}>
                    {m.member_name.trim().charAt(0)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-[0.9375rem] ${isMe ? 'font-bold' : 'font-medium'}`}>{m.member_name}</div>
                    {owed !== undefined && (
                      <div className={`text-xs ${owed > 0n ? 'font-semibold text-bad' : 'text-muted'}`}>
                        {owed > 0n ? t('home.totalOwed', { amount: taka(owed) }) : t('home.noArrears')}
                      </div>
                    )}
                  </div>
                  <StatusPill status={cell?.pending && !settled ? 'pending' : cell?.advance ? 'advance' : (cell?.status ?? 'unpaid')} />
                </li>
              );
            })}
          </ul>
          {members && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
              <span className="text-muted">{t('home.groupOwed')}</span>
              <span className={`font-bold ${groupOwed > 0n ? 'text-bad' : ''}`}>{taka(groupOwed)}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
