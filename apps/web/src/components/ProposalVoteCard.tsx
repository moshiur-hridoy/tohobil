import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PillWithTimeLeft, TurnoutDots, VoteMeter, voteTally, writtenText } from './ProposalCardParts';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { ProposalSummary } from '../lib/types';
import { choiceTone } from '../lib/voteTone';

const CHOICES = ['yes', 'no', 'abstain'] as const;

/** A member's card for one proposal, with the vote buttons while they may vote: the vote list and Home. */
export function ProposalVoteCard({ proposal }: { proposal: ProposalSummary }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vote = useMutation({
    mutationFn: (choice: (typeof CHOICES)[number]) => api(`/proposals/${proposal.id}/vote`, { method: 'POST', body: { choice } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proposals'] }),
  });
  const mine = proposal.my_choice ?? null;
  const tally = voteTally(proposal, t);
  const written = proposal.payload ? writtenText(proposal.payload) : undefined;
  const voters = proposal.voters ?? [];
  return (
    <div data-testid="proposal-card" className="relative rounded-[20px] border border-border bg-card shadow-card transition-colors hover:border-track">
      {/* The link's hit area is stretched over the whole card (its ::after); only the vote buttons sit above it. */}
      <Link to={`/votes/${proposal.id}`} className="block space-y-3 rounded-[20px] p-4 outline-none after:absolute after:inset-0 after:rounded-[20px] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring">
        <div className="min-w-0 space-y-1">
          <p className="text-base font-bold leading-snug [overflow-wrap:anywhere]">{proposal.title}</p>
          {written && <p className="line-clamp-2 text-sm text-muted [overflow-wrap:anywhere]">{written}</p>}
        </div>
        {tally.counted && tally.yes !== null && <VoteMeter tally={tally} status={proposal.status} />}
        {(proposal.can_vote || voters.length > 0) && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {proposal.can_vote && <span className="text-sm font-bold">{t('votes.yourVote')}</span>}
          {voters.length > 0 && <TurnoutDots voters={voters} />}
        </div>}
      </Link>

      {proposal.can_vote && (
        <div className="px-4 pb-3">
          <div className="relative z-10 grid grid-cols-3 gap-2">
            {CHOICES.map((choice) => {
              const active = mine === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={active}
                  disabled={vote.isPending}
                  onClick={() => vote.mutate(choice)}
                  className={`h-12 rounded-2xl text-base font-bold disabled:opacity-50 ${choiceTone(choice, active)}`}
                >
                  {active ? `${t(`votes.${choice}`)} ✓` : t(`votes.${choice}`)}
                </button>
              );
            })}
          </div>
          {vote.error && <p role="alert" className="mt-2 text-bad">{errorMessage(t, vote.error).message}</p>}
        </div>
      )}

      {/* Under the buttons: beside the title the pair broke apart on a phone (owner). */}
      <div className="px-4 pb-4">
        <PillWithTimeLeft status={proposal.status} closesAt={proposal.closes_at} className="justify-between" />
      </div>
    </div>
  );
}
