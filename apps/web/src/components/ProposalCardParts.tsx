/** What a proposal's card shows, shared by the members' vote list and the cashier's proposals page. */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { StatusPill } from './StatusPill';
import { CountdownChip } from './VoteCountdown';
import { formatCount, localDigits } from '../lib/format';
import { taka } from '../lib/money';
import type { ProposalSummary } from '../lib/types';

/** The payload fields that hold what the proposer wrote about it, whichever the type has. */
const WRITTEN_KEYS = ['text', 'description', 'purpose', 'reason', 'summary', 'notes', 'note', 'distribution_plan'];

export const writtenKey = (payload: Record<string, unknown>) =>
  WRITTEN_KEYS.find((k) => {
    const v = payload[k];
    return typeof v === 'string' && v.trim() !== '';
  });

export const writtenText = (payload: Record<string, unknown>) => {
  const key = writtenKey(payload);
  return key === undefined ? undefined : (payload[key] as string);
};

/** The proposal's amount as the one big figure under its title. */
export function AmountLine({ paisa }: { paisa: string }) {
  const { t } = useTranslation();
  return (
    <p className="flex items-baseline gap-1.5 text-meta"><span className="text-muted">{t('common.amount')}</span><span className="text-lg font-bold tabular-nums">{taka(paisa)}</span></p>
  );
}

/**
 * Yes votes and the pass mark, always with their unit: a share-weighted vote needs e.g. "9 shares (of 16)",
 * which read as a bare "9" looks like more people than the fund has. `yes` is null while ballots are hidden;
 * the two percentages (of everyone eligible) draw the vote bar.
 */
export function voteTally(
  p: Pick<ProposalSummary, 'ballots_hidden' | 'basis' | 'counts' | 'threshold' | 'threshold_weight' | 'eligible_count' | 'eligible_weight'> & { status: string },
  t: TFunction,
): { counted: boolean; yes: string | null; need: string; yesPercent: number; needPercent: number } {
  const byShare = p.basis === 'share';
  const yes = byShare ? String(p.counts.yes_weight) : String(p.counts.yes);
  const need = byShare ? String(p.threshold_weight) : String(p.threshold);
  const total = byShare ? String(p.eligible_weight) : String(p.eligible_count);
  // A draft (or one cancelled before opening) has no voters and a pass mark of 0, so 0 >= 0 must not read as passed.
  const counted = p.status !== 'draft' && BigInt(need) > 0n;
  const percent = (n: string) => (Number(total) > 0 ? Math.min(100, (Number(n) * 100) / Number(total)) : 0);
  return {
    counted,
    yes: p.ballots_hidden ? null : t(byShare ? 'proposal.countShares' : 'proposal.countMembers', { n: localDigits(yes) }),
    need: t(byShare ? 'proposal.needShares' : 'proposal.needMembers', { n: localDigits(need), total: localDigits(total) }),
    yesPercent: percent(yes),
    needPercent: percent(need),
  };
}

/**
 * The vote at a glance: yes votes as a bar, a tick where it passes, and the numbers in words. The bar
 * stays grey (red when rejected): the status pill already says how it ended, and a page of green bars
 * tired the eyes (owner).
 */
export function VoteMeter({ tally, status, voted, eligible, showNeed = false }: { tally: ReturnType<typeof voteTally>; status: string; voted?: number; eligible?: number; showNeed?: boolean }) {
  const { t } = useTranslation();
  const fill = status === 'rejected' ? 'bg-bad' : 'bg-muted';
  return (
    <div className="space-y-1.5 text-meta">
      {tally.yes !== null && (
        <p><span className="text-muted">{t('proposal.yesVotes')}</span> <span className="font-bold tabular-nums">{tally.yes}</span></p>
      )}
      {tally.yes !== null && (
        <div aria-hidden="true" className="relative h-2 rounded-full bg-track">
          <div className={`h-full rounded-full ${fill}`} style={{ width: `${tally.yesPercent}%` }} />
          <span className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink2" style={{ left: `${tally.needPercent}%` }} />
        </div>
      )}
      {(showNeed || voted !== undefined) && (
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted">
          {showNeed && <span>{t('proposal.needToPass')} <span className="tabular-nums">{tally.need}</span></span>}
          {voted !== undefined && eligible !== undefined && (
            <span data-testid="turnout">{t('proposalsPage.voted')} <span className="font-semibold tabular-nums">{formatCount(voted)}/{formatCount(eligible)}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

const pillStatus = (status: string) => (status === 'open' ? 'pending' : status);

/** The status pill, with the time left beside it while the vote runs; `className` places the pair. */
export function PillWithTimeLeft({ status, closesAt, className = 'ml-auto justify-end' }: { status: string; closesAt: string | null; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`flex flex-wrap items-center gap-2 ${className}`}>
      {status === 'open' && closesAt && <CountdownChip closesAt={closesAt} />}
      <StatusPill status={pillStatus(status)} label={t(`status.proposal.${status}`)} />
    </span>
  );
}

/** One dot per voter, in member order: solid green once they have voted, a red ring until then. Hovering names them. */
export function TurnoutDots({ voters }: { voters: NonNullable<ProposalSummary['voters']> }) {
  const { t } = useTranslation();
  const voted = voters.filter((v) => v.voted).length;
  return (
    <span
      data-testid="turnout"
      role="img"
      aria-label={`${t('proposalsPage.voted')} ${formatCount(voted)}/${formatCount(voters.length)}`}
      className="relative z-10 ml-auto flex max-w-full flex-wrap justify-end"
    >
      {voters.map((v) => (
        <span key={v.code} className="p-[3px]" title={`${v.code} ${v.full_name}: ${t(v.voted ? 'proposal.votedYes' : 'proposal.votedNo')}`}>
          {/* Not voted is only a ring, so a vote nobody has cast yet is not a row of red (owner). */}
          <span className={`block h-2.5 w-2.5 rounded-full border-[1.5px] ${v.voted ? 'border-ok bg-ok' : 'border-bad'}`} />
        </span>
      ))}
    </span>
  );
}
