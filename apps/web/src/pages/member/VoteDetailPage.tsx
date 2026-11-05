import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Icon } from '../../components/ui';
import { ClauseLink } from '../../components/ClauseSelect';
import { ProposalDetails } from '../../components/ProposalDetails';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { VoteCountdown } from '../../components/VoteCountdown';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useTimeLeft } from '../../lib/countdown';
import type { ProposalDetail } from '../../lib/types';
import { formatCount, localDigits } from '../../lib/format';

const CHOICES = ['yes', 'no', 'abstain'] as const;
type Choice = (typeof CHOICES)[number];

const CHOICE_ICON: Record<Choice, string> = {
  yes: 'M5 12l5 5 9-10',
  no: 'M6 6l12 12M18 6L6 18',
  abstain: 'M6 12h12',
};
/** A ballot's pill in the voter list: colour plus the word, never colour alone. */
const CHOICE_PILL: Record<Choice, string> = {
  yes: 'bg-ok-bg text-ok',
  no: 'bg-bad-bg text-bad',
  abstain: 'bg-soft text-ink2',
};
const ICON_RESULT = 'M4 20v-6M10 20V5M16 20v-9M21 20H3';
const ICON_LOCK = 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z';
const ICON_PEOPLE = 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M15 3.1a3.5 3.5 0 0 1 0 6.8';

/** Integer percent of two non-negative whole numbers, for bar widths (no floating-point money). */
const pct = (part: bigint, whole: bigint): string => (whole > 0n ? `${Number((part * 1000n) / whole) / 10}%` : '0%');

export function VoteDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const qc = useQueryClient();

  const proposal = useQuery({
    queryKey: ['proposal', id],
    queryFn: () => api<ProposalDetail>(`/proposals/${id}`),
    enabled: !!id,
    // Once the countdown has run out, look again every 15 seconds until the server has closed the vote.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.status === 'open' && d.closes_at && new Date(d.closes_at).getTime() <= Date.now() ? 15_000 : false;
    },
  });

  const vote = useMutation({
    mutationFn: async (choice: Choice) => {
      await api(`/proposals/${id}/vote`, { method: 'POST', body: { choice } });
    },
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ['proposal', id] });
      await qc.invalidateQueries({ queryKey: ['proposals'] });
    },
  });

  const d = proposal.data;
  const left = useTimeLeft(d?.status === 'open' ? (d.closes_at ?? null) : null, 1000);
  const timeUp = left === 0;
  const isOpen = d?.status === 'open';
  const isSubject = !!d?.subject_member_id && me?.member_id === d.subject_member_id;
  const myVote = d?.votes.find((v) => v.member_id === me?.member_id);
  const canVote = isOpen && !timeUp && !isSubject && !vote.isPending;

  if (proposal.error) {
    return (
      <div className="p-4">
        <LoadError error={proposal.error} onRetry={() => void proposal.refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <header className="flex items-center gap-2">
        <Link to="/votes" aria-label={t('common.back')} className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-border bg-card text-foreground">
          <Icon d="M15 5l-7 7 7 7" size={22} sw={2} />
        </Link>
        <h1 className="flex-1 pl-1 text-[1.1875rem] font-bold">{t('votes.title')}</h1>
        {d && <StatusPill status={d.status === 'open' ? 'pending' : d.status} label={t(`status.proposal.${d.status}`)} />}
      </header>

      {!d ? (
        <ListSkeleton rows={6} />
      ) : (
        <>
          {isOpen && d.closes_at && <VoteCountdown closesAt={d.closes_at} />}

          {/* The proposal */}
          <section className="rounded-[20px] border border-border bg-card p-4 shadow-card">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">{t(`proposalType.${d.type}`)}</span>
              <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-ink2">{d.basis === 'share' ? t('proposal.byShares') : t('proposal.byMembers')}</span>
            </div>
            <h2 className="mt-3 text-[1.375rem] font-bold leading-snug [overflow-wrap:anywhere]">{d.title}</h2>
            {d.description && <p className="mt-2 whitespace-pre-line text-ink2 [overflow-wrap:anywhere]">{d.description}</p>}
            {d.subject && (
              <p className="mt-2 text-sm text-muted">
                {t('proposal.subject')}: <span className="font-semibold text-foreground">{d.subject.code} {d.subject.full_name}</span>
              </p>
            )}
            {d.clause_ref && <ClauseLink clause={d.clause_ref} className="mt-2 inline-block text-sm" />}
            <div className="mt-3">
              <ProposalDetails type={d.type} payload={d.payload} />
            </div>
          </section>

          {/* Your vote, while the vote is open */}
          {isOpen && (
            <section className="rounded-[20px] border border-border bg-card p-4 shadow-card">
              <h3 className="text-base font-bold">{t('votes.yourVote')}</h3>
              {isSubject ? (
                <p className="mt-2 rounded-xl bg-warn-bg p-2.5 text-sm text-warn">{t('votes.cannotVoteSubject')}</p>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {CHOICES.map((choice) => (
                      <ChoiceButton key={choice} choice={choice} active={myVote?.choice === choice} anyChosen={!!myVote} disabled={!canVote} onPick={() => vote.mutate(choice)} />
                    ))}
                  </div>
                  {vote.error && (
                    <p role="alert" className="mt-2 text-sm text-bad">
                      {vote.error instanceof ApiError
                        ? t(`errors.${vote.error.code}`, { defaultValue: `${vote.error.message} (${vote.error.code})` })
                        : t('errors.generic')}
                    </p>
                  )}
                  {myVote ? (
                    <p data-testid="voted-label" className="mt-2.5 text-sm font-semibold text-ok">
                      ✓ {t('votes.youVoted', { choice: t(`votes.${myVote.choice}`) })}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted">{timeUp ? t('votes.countdown.counting') : t('votes.changeHint')}</p>
                </>
              )}
            </section>
          )}

          <ResultCard d={d} />

          <VoterList d={d} myId={me?.member_id} />
        </>
      )}
    </div>
  );
}

function ChoiceButton({ choice, active, anyChosen, disabled, onPick }: { choice: Choice; active: boolean; anyChosen: boolean; disabled: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  // Before voting "yes" is the filled button; after voting the chosen one is filled and the rest outlined.
  const tone = active
    ? choice === 'yes'
      ? 'bg-ok text-primary-foreground'
      : choice === 'no'
        ? 'bg-bad text-primary-foreground'
        : 'bg-muted text-primary-foreground'
    : choice === 'yes' && !anyChosen
      ? 'bg-primary text-primary-foreground'
      : choice === 'no'
        ? 'border-[1.5px] border-bad bg-card text-bad'
        : choice === 'yes'
          ? 'border-[1.5px] border-ok bg-card text-ok'
          : 'border-[1.5px] border-border bg-card text-ink2';
  return (
    <button
      type="button"
      data-testid={`vote-${choice}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPick}
      className={`flex h-[54px] items-center justify-center gap-1.5 rounded-2xl text-base font-bold transition-transform active:scale-95 disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 ${tone}`}
    >
      <Icon d={CHOICE_ICON[choice]} size={20} sw={2.2} />
      {t(`votes.${choice}`)}
    </button>
  );
}

/**
 * While the vote is open the tally is hidden (only who has voted is known), so the card shows the
 * turnout and what is needed to pass. Once it closes: the yes/no bar against everyone eligible.
 */
function ResultCard({ d }: { d: ProposalDetail }) {
  const { t } = useTranslation();
  const byShare = d.basis === 'share';
  const amount = (n: bigint | number) => (byShare ? t('proposal.countShares', { n: formatCount(Number(n)) }) : t('proposal.countMembers', { n: formatCount(Number(n)) }));
  const eligible = byShare ? BigInt(d.eligible_weight) : BigInt(d.eligible_count);
  const need = byShare ? BigInt(d.threshold_weight) : BigInt(d.threshold);
  const needText = byShare
    ? t('proposal.needShares', { n: localDigits(String(need)), total: localDigits(String(eligible)) })
    : t('proposal.needMembers', { n: localDigits(String(need)), total: localDigits(String(eligible)) });

  if (d.ballots_hidden) {
    const voted = d.voters.filter((v) => v.voted).length;
    const total = d.voters.length;
    return (
      <section className="rounded-[20px] border border-border bg-card p-4 shadow-card">
        <div className="flex items-center gap-3">
          <Chip tone="bg-primary-soft text-primary" d={ICON_PEOPLE} />
          <h3 className="flex-1 text-base font-bold">{t('votes.turnoutTitle')}</h3>
          <span className="text-sm font-semibold">{localDigits(`${voted}/${total}`)}</span>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-soft" role="img" aria-label={t('votes.turnout', { voted: formatCount(voted), total: formatCount(total) })}>
          <div className="h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: pct(BigInt(voted), BigInt(total)) }} />
        </div>
        <p className="mt-2 text-sm text-ink2">{t('votes.turnout', { voted: formatCount(voted), total: formatCount(total) })}</p>
        <p className="mt-3 text-sm">
          <span className="text-muted">{t('proposal.needToPass')}: </span>
          <span className="font-semibold">{needText}</span>
        </p>
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-soft p-2.5 text-xs text-ink2">
          <span className="mt-px shrink-0 text-muted"><Icon d={ICON_LOCK} size={16} /></span>
          {t('votes.hiddenUntilClose')}
        </p>
      </section>
    );
  }

  const c = d.counts;
  const yes = byShare ? BigInt(c.yes_weight) : BigInt(c.yes);
  const no = byShare ? BigInt(c.no_weight) : BigInt(c.no);
  const abstain = byShare ? BigInt(c.abstain_weight) : BigInt(c.abstain);
  const notVoted = eligible - yes - no - abstain > 0n ? eligible - yes - no - abstain : 0n;
  const passed = need > 0n && yes >= need;
  const legend = [
    ['bg-ok', t('votes.yes'), yes],
    ['bg-bad', t('votes.no'), no],
    ['bg-muted', t('votes.abstain'), abstain],
    ['border border-border bg-soft', t('votes.notVotedShort'), notVoted],
  ] as const;
  return (
    <section className="rounded-[20px] border border-border bg-card p-4 shadow-card">
      <div className="flex items-center gap-3">
        <Chip tone="bg-primary-soft text-primary" d={ICON_RESULT} />
        <h3 className="flex-1 text-base font-bold">{t('votes.result')}</h3>
        <span className="text-sm text-muted">{t('votes.totalOf', { amount: amount(eligible) })}</span>
      </div>
      <div className="mt-3.5 flex h-3.5 gap-0.5 overflow-hidden rounded-full bg-soft" aria-hidden="true">
        {yes > 0n && <div className="h-full bg-ok" style={{ width: pct(yes, eligible) }} />}
        {no > 0n && <div className="h-full bg-bad" style={{ width: pct(no, eligible) }} />}
        {abstain > 0n && <div className="h-full bg-muted" style={{ width: pct(abstain, eligible) }} />}
      </div>
      <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {legend.map(([dot, label, n]) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden="true" />
            <dt>{label}</dt>
            <dd className="font-bold">{localDigits(String(n))}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm">
        <span className="text-muted">{t('proposal.needToPass')}: </span>
        <span className="font-semibold">{needText}</span>
      </p>
      {passed && <p className="mt-1 text-sm font-semibold text-ok">✓ {t('proposal.passed')}</p>}
    </section>
  );
}

/** Everyone eligible, with whether they voted (while open) or what they voted (after it closes). */
function VoterList({ d, myId }: { d: ProposalDetail; myId: string | undefined }) {
  const { t } = useTranslation();
  const voted = d.voters.filter((v) => v.voted).length;
  return (
    <section className="rounded-[20px] border border-border bg-card px-4 pb-2 pt-4 shadow-card">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h3 className="text-base font-bold">{d.ballots_hidden ? t('proposal.voterList') : t('votes.whoVoted')}</h3>
        <span className="text-sm text-muted">{localDigits(`${voted}/${d.voters.length}`)}</span>
      </div>
      <ul>
        {d.voters.map((v) => {
          const cast = d.ballots_hidden ? undefined : d.votes.find((b) => b.member_id === v.member_id);
          const me = v.member_id === myId;
          // While the vote is open only whether they voted is shown, never their choice.
          const [pill, label] = cast
            ? [CHOICE_PILL[cast.choice], t(`votes.${cast.choice}`)]
            : v.voted
              ? ['bg-ok-bg text-ok', t('proposal.votedYes')]
              : ['bg-soft text-muted', t('proposal.votedNo')];
          return (
            <li key={v.member_id} className="flex min-h-[52px] items-center gap-3 border-t border-border py-2">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold ${me ? 'bg-primary text-primary-foreground' : 'bg-primary-soft text-primary'}`} aria-hidden="true">
                {Array.from(v.full_name.trim())[0] ?? '?'}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[0.9375rem] ${me ? 'font-bold' : 'font-medium'}`}>
                  {v.full_name}
                  {me && <span className="font-normal text-muted"> ({t('votes.you')})</span>}
                </span>
                <span className="block text-xs text-muted">
                  {v.code}
                  {d.basis === 'share' && <> · {t('proposal.countShares', { n: formatCount(v.weight) })}</>}
                </span>
              </span>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${pill}`}>
                {v.voted && !cast && <span aria-hidden="true">✓</span>}
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
