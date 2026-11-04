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
import { RoleBadges } from '../../components/RoleBadge';
import { Avatar } from '../../components/MemberPhoto';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtClock, fmtDate, fmtPeriod, todayDhaka } from '../../lib/dates';
import { arrearsOf, negClass, profitPercent, taka } from '../../lib/money';
import { charityBalance, fundSplit, shareValue } from '../../lib/nav';
import { useCountdown } from '../../lib/countdown';
import { advanceOf } from '../../lib/advance';
import { thisMonthOf } from '../../lib/thisMonth';
import { formatCount } from '../../lib/format';
import type { AccountBalance, ApprovalRow, DueRow, MatrixResponse, MeetingRow, MemberRow, NavResponse, ProposalSummary } from '../../lib/types';

const AVATAR = ['bg-primary-soft text-primary', 'bg-blue-bg text-blue', 'bg-vio-bg text-vio', 'bg-warn-bg text-warn'];

export function HomePage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const accounts = useQuery({ queryKey: ['balances'], queryFn: () => api<{ items: AccountBalance[] }>('/accounts/balances') });
  const nav = useQuery({ queryKey: ['nav'], queryFn: () => api<NavResponse>('/nav') });
  const myDues = useQuery({
    queryKey: ['dues', 'me', me?.member_id],
    enabled: !!me,
    queryFn: () => api<{ items: DueRow[] }>(`/dues?member_id=${me?.member_id}&limit=60`),
  });

  // Own detail: carries the advance credit not yet spent on a due.
  const myDetail = useQuery({
    queryKey: ['member', me?.member_id],
    enabled: !!me?.member_id,
    queryFn: () => api<{ credit_paisa?: string; dues: Array<{ period: string; kind: string; amount_paisa: string; outstanding_paisa: string; due_date: string }> }>(`/members/${me?.member_id}`),
  });

  const proposals = useQuery({
    queryKey: ['proposals', 'member'],
    queryFn: () => api<{ items: ProposalSummary[]; next_cursor: string | null }>('/proposals?limit=200'),
  });
  const openVotes = proposals.data?.items.filter((p) => p.status === 'open') ?? [];
  const firstOpen = openVotes[0];
  const meeting = useQuery({ queryKey: ['meetings', 'next'], queryFn: () => api<{ meeting: MeetingRow | null }>('/meetings/next') });
  const nextMeeting = meeting.data?.meeting;
  // The auditor decides value updates and reversals; without a computer this card is the way in.
  const isAuditor = !!me?.roles.includes('auditor');
  const approvals = useQuery({
    queryKey: ['approvals', 'pending'],
    enabled: isAuditor,
    queryFn: () => api<{ items: ApprovalRow[] }>('/approvals?status=pending&limit=200'),
  });
  const waitingApprovals = approvals.data?.items.filter((a) => a.requested_by_code !== me?.member_code).length ?? 0;
  const remaining = useCountdown(firstOpen?.closes_at ?? null);

  const mine = members.data?.items.find((m) => m.id === me?.member_id);
  // Dues past their due date and unpaid fines are arrears (the red card). This month's dues are open
  // from the 1st and shown with their due date; dues made for a later month only as the next due date.
  const principal = BigInt(mine?.overdue_paisa ?? '0');
  const fines = BigInt(mine?.outstanding_fines_paisa ?? '0');
  const owed = principal + fines;
  const today = todayDhaka();
  const now = thisMonthOf(myDues.data?.items ?? [], today);
  const toPay = owed + now.amount;
  const nextDue = myDues.data?.items
    .filter((d) => BigInt(d.outstanding_paisa) > 0n)
    .map((d) => d.due_date)
    .sort()[0];
  const advance = myDetail.data ? advanceOf(myDetail.data.dues, myDetail.data.credit_paisa ?? '0', today) : null;
  const gold = toPay === 0n && !!advance && advance.months > 0;
  const dueChip =
    now.dueDate === null || now.daysLeft === null
      ? null
      : now.daysLeft > 0
        ? t('home.dueOnLeft', { date: fmtDate(now.dueDate), days: formatCount(now.daysLeft) })
        : now.daysLeft === 0
          ? t('home.dueOnToday', { date: fmtDate(now.dueDate) })
          : t('home.dueOnPassed', { date: fmtDate(now.dueDate) });
  // The shorter form beside arrears, where the chips already fill the line.
  const daysChip =
    now.daysLeft === null ? null : now.daysLeft > 0 ? t('home.daysLeft', { days: formatCount(now.daysLeft) }) : t(now.daysLeft === 0 ? 'home.lastDayToday' : 'home.datePassed');

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['members'] }),
      qc.invalidateQueries({ queryKey: ['balances'] }),
      qc.invalidateQueries({ queryKey: ['nav'] }),
      qc.invalidateQueries({ queryKey: ['dues'] }),
      qc.invalidateQueries({ queryKey: ['member', me?.member_id] }),
      qc.invalidateQueries({ queryKey: ['matrix'] }),
      qc.invalidateQueries({ queryKey: ['meetings', 'next'] }),
    ]);

  if (members.error) return <div className="p-4"><LoadError error={members.error} onRetry={() => void members.refetch()} /></div>;

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        {/* Outstanding hero card */}
        <section className={`relative overflow-hidden rounded-3xl bg-hero p-5 text-on-hero ${owed > 0n ? 'hero-alert' : gold ? 'hero-gold' : ''}`} aria-labelledby="home-outstanding">
          <svg aria-hidden="true" width="200" height="200" viewBox="0 0 200 200" className={`absolute -right-[50px] -top-[60px] ${gold ? 'text-hero-action opacity-[0.28]' : 'opacity-[0.14]'}`}>
            <circle cx="100" cy="100" r="96" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="100" cy="100" r="66" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="100" cy="100" r="36" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div className="relative">
            <h2 id="home-outstanding" className="flex items-center gap-2.5 text-sm font-normal">
              <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-hero-icon">
                <Icon d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 10h18 M16 14.5h2" size={18} />
              </span>
              {t(owed > 0n ? (now.amount > 0n ? 'home.toPayTotal' : 'home.myOutstanding') : now.amount > 0n ? 'home.toPayThisMonth' : 'home.myOutstanding')}
              {gold && (
                <span className="ml-auto rounded-full border border-hero-action px-2.5 py-0.5 text-xs font-semibold text-hero-action">
                  ★ {t('home.advanceBadge')}
                </span>
              )}
            </h2>
            {!mine ? (
              <Skeleton className="mt-3 h-10 w-40" />
            ) : (
              <>
                <p className="mt-2.5 text-[2.625rem] font-bold leading-[1.15]">{taka(toPay)}</p>
                {owed === 0n && now.amount > 0n ? (
                  <div className="mt-2.5 flex flex-wrap gap-2 text-[0.8125rem]">
                    <span className={`rounded-full px-2.5 py-1 ${now.daysLeft !== null && now.daysLeft <= 3 ? 'bg-hero-action font-semibold text-on-hero-action' : 'bg-hero-chip'}`}>{dueChip}</span>
                  </div>
                ) : owed === 0n ? (
                  <>
                    <p className="mt-2.5 text-sm">{t('home.outstandingNone')}</p>
                    {advance && advance.months > 0 && advance.through && (
                      <p className="mt-1.5 text-[0.9375rem] font-semibold text-hero-action">
                        {t('home.advanceMonths', { months: formatCount(advance.months), month: fmtPeriod(advance.through) })}
                      </p>
                    )}
                    {advance && advance.extra > 0n && (
                      <p className="mt-1 text-[0.8125rem]">
                        {t(advance.months > 0 ? 'home.advanceExtra' : 'home.advanceCredit', { amount: taka(advance.extra) })}
                      </p>
                    )}
                    {nextDue && (
                      <div className="mt-2.5 flex flex-wrap gap-2 text-[0.8125rem]">
                        <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.nextDueOn', { date: fmtDate(nextDue) })}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-2.5 flex flex-wrap gap-2 text-[0.8125rem]">
                    {principal > 0n && <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.overdue')} {taka(principal)}</span>}
                    {fines > 0n && <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.fines')} {taka(fines)}</span>}
                    {now.amount > 0n ? (
                      <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.thisMonthPart', { amount: taka(now.amount) })} · {daysChip}</span>
                    ) : (
                      nextDue && <span className="rounded-full bg-hero-chip px-2.5 py-1">{t('home.nextDueOn', { date: fmtDate(nextDue) })}</span>
                    )}
                  </div>
                )}
                {mine.under_verification && (
                  <p role="status" className="mt-3 rounded-xl bg-warn-bg p-2.5 text-sm text-warn">
                    <strong>{t('home.underVerification')}.</strong> {t('home.underVerificationHint')}
                  </p>
                )}
                <Link to="/pay" className="mt-[18px] flex h-[54px] w-full items-center justify-center gap-2 rounded-2xl bg-hero-action text-[1.0625rem] font-bold text-on-hero-action">
                  {toPay === 0n ? t('home.payAdvance') : t('home.payNow')}
                  <Icon d="M5 12h14 M13 6l6 6-6 6" size={20} sw={2} />
                </Link>
              </>
            )}
          </div>
        </section>

        <FundCard nav={nav.data} />

        <section className="grid grid-cols-2 gap-3">
          {mine?.status !== 'inactive' && <MyShareTile nav={nav.data} mine={mine} toPay={toPay} />}
          <div className={`min-w-0 rounded-[18px] border border-border bg-card p-3.5 ${mine?.status === 'inactive' ? 'col-span-2' : ''}`}>
            <Chip tone="bg-blue-bg text-blue" d="M12 3l9 5-9 5-9-5z M3 13l9 5 9-5" />
            <h2 className="mt-2.5 text-[0.8125rem] font-normal text-muted">{t('home.myCapital')}</h2>
            <p className="mt-0.5 text-[1.3125rem] font-bold [overflow-wrap:anywhere]">{mine ? taka(mine.capital_paisa) : '…'}</p>
            {mine && <p className="mt-0.5 text-xs text-muted">{t('home.sharesCount', { count: mine.shares })}</p>}
          </div>
          {/* Charity balance (18.2): fines and riba are donated at year end, never fund income */}
          <div className="col-span-2 flex items-center gap-3 rounded-[18px] border border-border bg-card px-3.5 py-3">
            <Chip tone="bg-vio-bg text-vio" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
            <h2 className="flex-1 text-[0.8125rem] font-normal text-muted">{t('home.charityToDonate')}</h2>
            <p className="text-[1.1875rem] font-bold">{accounts.data ? taka(charityBalance(accounts.data.items)) : '…'}</p>
          </div>
        </section>

        {isAuditor && waitingApprovals > 0 && (
          <Link to="/approvals" className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-3.5 text-foreground">
            <Chip tone="bg-blue-bg text-blue" size={40} iconSize={22} d="M5 12l4 4 10-10" />
            <div className="min-w-0 flex-1">
              <div className="text-base font-bold">{t('home.approvalsWaiting', { count: waitingApprovals })}</div>
              <div className="truncate text-[0.8125rem] text-ink2">{t('home.approvalsWaitingSub')}</div>
            </div>
            <span className="text-muted"><Icon d="M9 5l7 7-7 7" sw={2} /></span>
          </Link>
        )}

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

/** Display only: a share of a bar as a CSS width. */
function pct(part: bigint, whole: bigint): string {
  return whole > 0n ? `${Number((part * 10000n) / whole) / 100}%` : '0%';
}

/**
 * The fund's net assets from `GET /nav` (the same figure as the Assets tab, with the latest shop
 * values), and where the money is: cash, invested, and what is owed to others. Taps through to Assets.
 */
function FundCard({ nav }: { nav: NavResponse | undefined }) {
  const { t } = useTranslation();
  const split = nav ? fundSplit(nav) : null;
  const cashBar = split && split.cash > 0n ? split.cash : 0n;
  const investedBar = split && split.invested > 0n ? split.invested : 0n;
  return (
    <Link to="/assets" className="block rounded-[18px] border border-border bg-card p-3.5 text-foreground">
      <div className="flex items-center gap-2.5">
        <Chip tone="bg-primary-soft text-primary" d="M3 17l6-6 4 4 8-8 M15 7h6v6" />
        <h2 className="flex-1 text-[0.8125rem] font-normal text-muted">{t('home.fundNetAssets')}</h2>
        <span className="text-muted"><Icon d="M9 5l7 7-7 7" sw={2} /></span>
      </div>
      {split ? (
        <>
          <p className={`mt-2 text-[1.75rem] font-bold leading-tight [overflow-wrap:anywhere] ${negClass(split.net)}`}>{taka(split.net)}</p>
          {cashBar + investedBar > 0n && (
            <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-background" aria-hidden="true">
              {cashBar > 0n && <span className="h-full bg-vio" style={{ width: pct(cashBar, cashBar + investedBar) }} />}
              {investedBar > 0n && <span className="h-full bg-primary" style={{ width: pct(investedBar, cashBar + investedBar) }} />}
            </div>
          )}
          <dl className="mt-3 grid gap-1.5 text-[0.875rem]">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-vio" aria-hidden="true" />
              <dt className="flex-1 text-muted">{t('home.split.cash')}</dt>
              <dd className={`font-semibold ${negClass(split.cash)}`}>{taka(split.cash)}</dd>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
              <dt className="flex-1 text-muted">{t('home.split.invested')}</dt>
              <dd className="font-semibold">{taka(split.invested)}</dd>
            </div>
            {split.owed !== 0n && (
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full border border-border" aria-hidden="true" />
                <dt className="flex-1 text-muted">{t('home.split.owed')}</dt>
                <dd className="font-semibold">−{taka(split.owed)}</dd>
              </div>
            )}
          </dl>
        </>
      ) : (
        <>
          <Skeleton className="mt-2 h-8 w-40" />
          <Skeleton className="mt-3 h-2.5 w-full" />
        </>
      )}
    </Link>
  );
}

/**
 * What the member's shares are worth today (settlement "gross", Doc.md 5.10). A member who owes money
 * also sees the value after it is paid, so the figure never looks larger than what they would get;
 * a member who is up to date sees the rise or fall against what they paid in.
 */
function MyShareTile({ nav, mine, toPay }: { nav: NavResponse | undefined; mine: MemberRow | undefined; toPay: bigint }) {
  const { t } = useTranslation();
  const value = nav && mine ? shareValue(nav, mine.shares) : null;
  const capital = mine ? BigInt(mine.capital_paisa) : 0n;
  const gain = value === null ? 0n : value - capital;
  const percent = profitPercent(gain, capital);
  return (
    <div className="min-w-0 rounded-[18px] border border-border bg-card p-3.5">
      <Chip tone="bg-ok-bg text-ok" d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      <h2 className="mt-2.5 text-[0.8125rem] font-normal text-muted">{t('home.myShareValue')}</h2>
      {value === null ? (
        <Skeleton className="mt-1 h-7 w-28" />
      ) : (
        <>
          <p className={`mt-0.5 text-[1.3125rem] font-bold [overflow-wrap:anywhere] ${negClass(value)}`}>{taka(value)}</p>
          {toPay > 0n ? (
            // Never a minus figure here: a new fund (or a member who has not paid yet) just sees what is left to pay.
            value - toPay > 0n ? (
              <p className="mt-0.5 text-xs text-muted">
                {t('home.shareAfterDues')} <span className="font-semibold">{taka(value - toPay)}</span>
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-warn">{t('home.shareToPay', { amount: taka(toPay) })}</p>
            )
          ) : (
            capital > 0n &&
            gain !== 0n && (
              <p className={`mt-0.5 text-xs font-semibold ${gain > 0n ? 'text-ok' : 'text-bad'}`}>
                {gain > 0n ? '+' : '−'}
                {taka(gain > 0n ? gain : -gain)}
                {percent && ` (${gain > 0n ? '+' : '−'}${percent})`}
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}

/** The whole fund term is three years (the matrix's limit too), so one request covers every month and switching is instant. */
const HISTORY_MONTHS = 36;
/** Years after this one that can be browsed: months paid ahead show there before their dues exist. */
const YEARS_AHEAD = 2;

/**
 * Everyone's standing for any month (the matrix is readable by every member), plus what each member
 * owes in total right now: overdue dues and unpaid fines (the hero card adds this month's open dues).
 */
function EveryoneStanding({ members }: { members?: MemberRow[] }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const current = todayDhaka().slice(0, 7);
  // History up to this December, then the next years in a second request (one request is at most 36
  // months): months already paid ahead show there, from the advance, before their dues exist.
  const yearEnd = `${current.slice(0, 4)}-12`;
  const from = addMonths(yearEnd, -(HISTORY_MONTHS - 1));
  const last = addMonths(yearEnd, 12 * YEARS_AHEAD);
  const [period, setPeriod] = useState(current);

  const past = useQuery({ queryKey: ['matrix', from, yearEnd], queryFn: () => api<MatrixResponse>(`/matrix?from=${from}&to=${yearEnd}`) });
  const coming = useQuery({
    queryKey: ['matrix', addMonths(yearEnd, 1), last],
    queryFn: () => api<MatrixResponse>(`/matrix?from=${addMonths(yearEnd, 1)}&to=${last}`),
  });
  const matrix = {
    error: past.error ?? coming.error,
    refetch: () => Promise.all([past.refetch(), coming.refetch()]),
    data:
      past.data && coming.data
        ? {
            periods: [...past.data.periods, ...coming.data.periods],
            members: past.data.members.map((m) => ({
              ...m,
              cells: { ...m.cells, ...coming.data.members.find((c) => c.member_id === m.member_id)?.cells },
            })),
          }
        : undefined,
  };

  // Months before the fund's first due are not offered.
  const first = matrix.data?.periods.find((p) => matrix.data?.members.some((m) => m.cells[p])) ?? current;
  const owedById = new Map(members?.map((m) => [m.id, arrearsOf(m)]));
  const rolesById = new Map(members?.map((m) => [m.id, m.roles]));
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
      <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
        <Chip tone="bg-primary-soft text-primary" d="M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M20 20v-1a4 4 0 0 0-3-3.8 M16 4.2a3.5 3.5 0 0 1 0 6.6" />
        <h2 id="home-everyone" className="min-w-0 flex-1 text-base font-bold">{t('home.everyoneInMonth')}</h2>
        {matrix.data && rows.length > 0 && (
          <span className="flex flex-none items-center gap-2">
            <span aria-hidden="true" className="h-2 w-24 overflow-hidden rounded-full bg-track">
              <span className="block h-full bg-primary" style={{ width: `${(paidCount / rows.length) * 100}%` }} />
            </span>
            <span className="text-sm font-bold text-primary">{paidCount}/{rows.length}</span>
          </span>
        )}
      </div>

      {/* Month switcher: from the fund's first month up to December two years ahead */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        {arrow('M15 5l-7 7 7 7', t('home.prevMonth'), addMonths(period, -1), !matrix.data || period <= first)}
        <p className="flex-1 text-center text-[0.9375rem] font-bold" aria-live="polite">{fmtPeriod(period)}</p>
        {arrow('M9 5l7 7-7 7', t('home.nextMonth'), addMonths(period, 1), period >= last)}
      </div>

      {matrix.error ? (
        <div className="p-4"><LoadError error={matrix.error} onRetry={() => void matrix.refetch()} /></div>
      ) : !matrix.data ? (
        <div className="p-4"><ListSkeleton rows={4} /></div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-5 text-center text-sm text-muted">{t(period > current ? 'home.duesNotYetCreated' : 'home.noDuesInMonth')}</p>
      ) : (
        <>
          <ul>
            {rows.map((m, i) => {
              const cell = m.cells[period];
              const isMe = m.member_id === me?.member_id;
              const owed = owedById.get(m.member_id);
              const settled = cell?.status === 'paid' || cell?.status === 'paid_late';
              return (
                <li key={m.member_id} className={`flex min-h-[58px] items-center gap-3 border-border px-4 py-2 ${i ? 'border-t' : ''} ${isMe ? 'bg-primary-soft' : ''}`}>
                  <Avatar fileId={m.member_photo_file_id} fallback={m.member_name.trim().charAt(0)} className={`h-[34px] w-[34px] text-sm font-bold ${isMe ? 'bg-primary text-primary-foreground' : AVATAR[i % AVATAR.length]}`} />
                  <div className="min-w-0 flex-1">
                    <div className={`flex min-w-0 items-center gap-1.5 text-[0.9375rem] ${isMe ? 'font-bold' : 'font-medium'}`}><span className="shrink-0 text-xs font-normal text-muted tabular-nums">{m.member_code}</span><span className="truncate">{m.member_name}</span><RoleBadges roles={rolesById.get(m.member_id)} /></div>
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
