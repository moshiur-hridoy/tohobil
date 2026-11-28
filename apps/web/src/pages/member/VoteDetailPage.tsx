import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/MemberPhoto';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Icon } from '../../components/ui';
import { ProposalDetails } from '../../components/ProposalDetails';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { VoteCountdown, closesAtText } from '../../components/VoteCountdown';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useTimeLeft } from '../../lib/countdown';
import type { ProposalDetail } from '../../lib/types';
import { formatCount, localDigits } from '../../lib/format';
import { choiceTone } from '../../lib/voteTone';

const CHOICES = ['yes', 'no', 'abstain'] as const;
type Choice = (typeof CHOICES)[number];

const CHOICE_ICON: Record<Choice, string> = {
  yes: 'M5 12l5 5 9-10',
  no: 'M6 6l12 12M18 6L6 18',
  abstain: 'M6 12h12',
};
/** A ballot's pill in the voter list: colour plus the word, never colour alone. */
const CHOICE_PILL: Record<Choice, string> = {
  yes: 'bg-accent-soft text-accent',
  no: 'bg-bad-bg text-bad',
  abstain: 'bg-soft text-ink2',
};
const ICON_RESULT = 'M4 20v-6M10 20V5M16 20v-9M21 20H3';

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

  // The voting sheet floats over the page, so the page ends with a gap of its height (it grows with large text).
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const [sheetHeight, setSheetHeight] = useState(0);
  useEffect(() => {
    if (!sheet) return;
    const observer = new ResizeObserver(() => setSheetHeight(sheet.offsetHeight));
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [sheet]);

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
        <Link to="/votes" aria-label={t('common.back')} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border bg-card text-foreground">
          <Icon d="M15 5l-7 7 7 7" size={22} sw={2} />
        </Link>
        <h1 className="flex-1 pl-1 text-title font-bold">{t('votes.title')}</h1>
        {d && <StatusPill status={d.status === 'open' ? 'pending' : d.status} label={t(`status.proposal.${d.status}`)} />}
      </header>

      {!d ? (
        <ListSkeleton rows={6} />
      ) : (
        <>
          {/* The proposal, under the time left while the vote runs */}
          <section className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
            {isOpen && d.closes_at && <VoteCountdown closesAt={d.closes_at} />}
            <div className="space-y-2 p-4">
              <h2 className="text-heading font-bold leading-snug [overflow-wrap:anywhere]">{d.title}</h2>
              {d.description && <p className="whitespace-pre-line text-ink2 [overflow-wrap:anywhere]">{d.description}</p>}
              {d.subject && (
                <p className="text-sm text-muted">
                  {t('proposal.subject')}: <span className="font-semibold text-foreground">{d.subject.code} {d.subject.full_name}</span>
                </p>
              )}
              <ProposalDetails type={d.type} payload={d.payload} plain />
              {isOpen && d.closes_at && <p className="pt-1 text-sm text-muted">{t('votes.countdown.closesAt', { when: closesAtText(t, d.closes_at) })}</p>}
            </div>
          </section>

          {/* Your vote, while the vote is open: a sheet fixed above the tab bar, within thumb reach (owner).
              The bottom padding keeps the buttons clear of the raised pay button. */}
          {isOpen && (
            <section
              ref={setSheet}
              data-testid="vote-sheet"
              className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] mx-auto max-h-[60dvh] max-w-lg overflow-y-auto rounded-t-xl border border-b-0 border-track bg-card px-4 pb-8 pt-3 shadow-[0_-12px_28px_-14px_rgba(0,0,0,0.45)]"
            >
              <h3 className="text-base font-bold">{t('votes.yourVote')}</h3>
              {isSubject ? (
                <p className="mt-2 rounded-md bg-warn-bg p-2.5 text-sm text-warn">{t('votes.cannotVoteSubject')}</p>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {CHOICES.map((choice) => (
                      <ChoiceButton key={choice} choice={choice} active={myVote?.choice === choice} disabled={!canVote} onPick={() => vote.mutate(choice)} />
                    ))}
                  </div>
                  {vote.error && (
                    <p role="alert" className="mt-2 text-sm text-bad">
                      {vote.error instanceof ApiError
                        ? t(`errors.${vote.error.code}`, { defaultValue: `${vote.error.message} (${vote.error.code})` })
                        : t('errors.generic')}
                    </p>
                  )}
                  <p className="mt-2.5 text-center text-xs leading-relaxed text-muted">{t(timeUp ? 'votes.countdown.counting' : 'votes.deadlineNote')}</p>
                </>
              )}
            </section>
          )}

          {!d.ballots_hidden && <ResultCard d={d} />}

          <VoterList d={d} myId={me?.member_id} />

          {isOpen && <div aria-hidden="true" style={{ height: `calc(${sheetHeight}px - 2rem + env(safe-area-inset-bottom))` }} />}
        </>
      )}
    </div>
  );
}

function ChoiceButton({ choice, active, disabled, onPick }: { choice: Choice; active: boolean; disabled: boolean; onPick: () => void }) {
  const { t } = useTranslation();
  const tone = choiceTone(choice, active);
  return (
    <button
      type="button"
      data-testid={`vote-${choice}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPick}
      className={`btn btn-lg gap-1.5 px-0 text-base transition-transform active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 ${tone}`}
    >
      <Icon d={CHOICE_ICON[choice]} size={20} sw={2.2} />
      {t(`votes.${choice}`)}
    </button>
  );
}

/** The yes/no bar against everyone eligible, once the vote closes. While it runs, the voter list below says who has voted (owner). */
function ResultCard({ d }: { d: ProposalDetail }) {
  const { t } = useTranslation();
  const byShare = d.basis === 'share';
  const amount = (n: bigint | number) => (byShare ? t('proposal.countShares', { n: formatCount(Number(n)) }) : t('proposal.countMembers', { n: formatCount(Number(n)) }));
  const eligible = byShare ? BigInt(d.eligible_weight) : BigInt(d.eligible_count);
  const need = byShare ? BigInt(d.threshold_weight) : BigInt(d.threshold);
  const needText = byShare
    ? t('proposal.needShares', { n: localDigits(String(need)), total: localDigits(String(eligible)) })
    : t('proposal.needMembers', { n: localDigits(String(need)), total: localDigits(String(eligible)) });

  const c = d.counts;
  const yes = byShare ? BigInt(c.yes_weight) : BigInt(c.yes);
  const no = byShare ? BigInt(c.no_weight) : BigInt(c.no);
  const abstain = byShare ? BigInt(c.abstain_weight) : BigInt(c.abstain);
  const notVoted = eligible - yes - no - abstain > 0n ? eligible - yes - no - abstain : 0n;
  const passed = need > 0n && yes >= need;
  const legend = [
    ['bg-accent', t('votes.yes'), yes],
    ['bg-bad', t('votes.no'), no],
    ['bg-muted', t('votes.abstain'), abstain],
    ['border border-border bg-soft', t('votes.notVotedShort'), notVoted],
  ] as const;
  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-card">
      <div className="flex items-center gap-3">
        <Chip tone="bg-accent-soft text-accent" d={ICON_RESULT} />
        <h3 className="flex-1 text-base font-bold">{t('votes.result')}</h3>
        <span className="text-sm text-muted">{t('votes.totalOf', { amount: amount(eligible) })}</span>
      </div>
      <div className="mt-3.5 flex h-3.5 gap-0.5 overflow-hidden rounded-full bg-soft" aria-hidden="true">
        {yes > 0n && <div className="h-full bg-accent" style={{ width: pct(yes, eligible) }} />}
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
      {passed && <p className="mt-1 text-sm font-semibold text-foreground">✓ {t('proposal.passed')}</p>}
    </section>
  );
}

/** Everyone eligible, with whether they voted (while open) or what they voted (after it closes). */
function VoterList({ d, myId }: { d: ProposalDetail; myId: string | undefined }) {
  const { t } = useTranslation();
  const voted = d.voters.filter((v) => v.voted).length;
  return (
    <section className="rounded-lg border border-border bg-card px-4 pb-2 pt-4 shadow-card">
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
              ? ['bg-soft text-ink2', t('proposal.votedYes')]
              : ['bg-soft text-muted', t('proposal.votedNo')];
          return (
            <li key={v.member_id} className="flex min-h-[52px] items-center gap-3 border-t border-border py-2">
              <Avatar fileId={v.photo_file_id} fallback={Array.from(v.full_name.trim())[0] ?? '?'} className={`h-9 w-9 text-sm font-bold ${me ? 'bg-accent-fill text-on-accent' : 'bg-accent-soft text-accent'}`} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-body ${me ? 'font-bold' : 'font-medium'}`}>
                  {v.full_name}
                  {me && <span className="font-normal text-muted"> ({t('votes.you')})</span>}
                </span>
                <span className="block text-xs text-muted">
                  {v.code}
                  {d.basis === 'share' && <> · {t('proposal.countShares', { n: formatCount(v.weight) })}</>}
                </span>
              </span>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-bold ${pill}`}>
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
