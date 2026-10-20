import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/ui';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCountdown } from '../../lib/countdown';
import { fmtInstant } from '../../lib/dates';
import type { ProposalDetail } from '../../lib/types';
import { PROPOSAL_TYPES } from '@barakah/shared';

const CHOICES = ['yes', 'no', 'abstain'] as const;

export function VoteDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const qc = useQueryClient();

  const proposal = useQuery({
    queryKey: ['proposal', id],
    queryFn: () => api<ProposalDetail>(`/proposals/${id}`),
    enabled: !!id,
  });

  const vote = useMutation({
    mutationFn: async (choice: (typeof CHOICES)[number]) => {
      await api(`/proposals/${id}/vote`, { method: 'POST', body: { choice } });
    },
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: ['proposal', id] });
      await qc.invalidateQueries({ queryKey: ['proposals'] });
    },
  });

  const remaining = useCountdown(proposal.data?.closes_at ?? null);
  const isOpen = proposal.data?.status === 'open';
  const isSubject = me?.member_id === proposal.data?.subject_member_id && !!proposal.data?.subject_member_id;
  const myVote = proposal.data?.votes.find((v) => v.member_id === me?.member_id);
  const canVote = isOpen && !isSubject && !vote.isPending;

  if (proposal.error) {
    return (
      <div className="p-4">
        <LoadError error={proposal.error} onRetry={() => void proposal.refetch()} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <Link to="/votes" aria-label={t('common.back')} className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground">
        <Icon d="M15 5l-7 7 7 7" size={22} sw={2} />
      </Link>

      {!proposal.data ? (
        <ListSkeleton rows={6} />
      ) : (
        <>
          <section className="rounded-[20px] border border-border bg-card p-4 shadow-card">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-[1.375rem] font-bold leading-snug">{proposal.data.title}</h2>
                <p className="text-sm text-muted">
                  {t(`proposalType.${proposal.data.type}`)} · {t('votes.deadline')}: {remaining ?? fmtInstant(proposal.data.closes_at ?? proposal.data.created_at)}
                </p>
              </div>
              <span className="rounded-full bg-warn-bg px-3 py-1 text-xs font-bold text-warn">{t(`status.proposal.${proposal.data.status}`)}</span>
            </div>

            {proposal.data.description && <p className="mt-2">{proposal.data.description}</p>}

            {proposal.data.subject && (
              <p className="mt-2 text-sm text-muted">
                {t('proposal.subject')}: {proposal.data.subject.code} {proposal.data.subject.full_name}
              </p>
            )}

            <PayloadPreview type={proposal.data.type as (typeof PROPOSAL_TYPES)[number]} payload={proposal.data.payload} />

            <div className="mt-4 rounded-2xl bg-background p-3.5">
              <p className="text-sm text-muted">{t('proposal.threshold')}</p>
              {proposal.data.ballots_hidden ? (
                <>
                  <p className="text-xl font-bold">
                    {t('votes.needToPass', { need: proposal.data.basis === 'share' ? proposal.data.threshold_weight : proposal.data.threshold })}{' '}
                    <span className="text-sm font-normal text-muted">
                      ({proposal.data.basis === 'share' ? t('proposal.byShares') : t('proposal.byMembers')})
                    </span>
                  </p>
                  <p className="mt-2 text-sm text-muted">{t('votes.hiddenUntilClose')}</p>
                </>
              ) : (
                <>
                  <p className="text-xl font-bold">
                    {proposal.data.basis === 'share'
                      ? `${proposal.data.counts.yes_weight} / ${proposal.data.threshold_weight}`
                      : `${proposal.data.counts.yes} / ${proposal.data.threshold}`}{' '}
                    <span className="text-sm font-normal text-muted">
                      ({proposal.data.basis === 'share' ? t('proposal.byShares') : t('proposal.byMembers')})
                    </span>
                  </p>
                  <div className="mt-2 flex gap-4 text-sm">
                    <span className="text-ok">{t('votes.yes')}: {proposal.data.counts.yes}</span>
                    <span className="text-bad">{t('votes.no')}: {proposal.data.counts.no}</span>
                    <span className="text-muted">{t('votes.abstain')}: {proposal.data.counts.abstain}</span>
                  </div>
                </>
              )}
            </div>

            {isSubject && (
              <p className="mt-3 rounded-xl bg-warn-bg p-2.5 text-warn">
                {t('votes.cannotVoteSubject')}
              </p>
            )}

            <div className="mt-4 grid grid-cols-3 gap-2">
              {CHOICES.map((choice) => {
                const active = myVote?.choice === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    data-testid={`vote-${choice}`}
                    aria-pressed={active}
                    disabled={!canVote}
                    onClick={() => vote.mutate(choice)}
                    className={`h-[54px] rounded-2xl text-base font-bold disabled:opacity-50 ${
                      choice === 'yes'
                        ? active
                          ? 'bg-ok text-primary-foreground'
                          : 'bg-primary text-primary-foreground'
                        : choice === 'no'
                          ? active
                            ? 'bg-bad text-primary-foreground'
                            : 'border-[1.5px] border-bad bg-card text-bad'
                          : active
                            ? 'bg-muted text-primary-foreground'
                            : 'border-[1.5px] border-border bg-card text-ink2'
                    }`}
                  >
                    {myVote?.choice === choice ? `${t(`votes.${choice}`)} ✓` : t(`votes.${choice}`)}
                  </button>
                );
              })}
            </div>

            {vote.error && (
              <p className="mt-2 text-bad">
                {vote.error instanceof ApiError
                  ? t(`errors.${vote.error.code}`, { defaultValue: `${vote.error.message} (${vote.error.code})` })
                  : t('errors.generic')}
              </p>
            )}

            {myVote && !isSubject && (
              <p data-testid="voted-label" className="mt-2 text-sm text-ok">
                {t('votes.youVoted', { choice: t(`votes.${myVote.choice}`) })}
              </p>
            )}
          </section>

          <section className="rounded-[20px] border border-border bg-card p-4 shadow-card">
            <h3 className="mb-1 text-base font-bold">{t('proposal.voterList')}</h3>
            {proposal.data.ballots_hidden && <p className="mb-1 text-xs text-muted">{t('votes.hiddenUntilClose')}</p>}
            <ul className="divide-y divide-border">
              {proposal.data.voters.map((v) => {
                const cast = proposal.data!.votes.find((vote) => vote.member_id === v.member_id);
                return (
                  <li key={v.member_id} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      {v.code} {v.full_name}
                      {proposal.data!.basis === 'share' && <span className="text-muted"> · {v.weight}</span>}
                    </span>
                    {!proposal.data!.ballots_hidden && (
                      <span className="font-medium">
                        {cast ? t(`votes.${cast.choice}`) : <span className="text-muted">{t('votes.notVoted')}</span>}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function PayloadPreview({ type, payload }: { type: (typeof PROPOSAL_TYPES)[number]; payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (type === 'general' || type === 'dissolution' || type === 'wind_up' || type === 'land_selection' || type === 'project_closure') {
    const text = payload.text as string | undefined;
    return text ? <p className="mt-2 rounded-md bg-background p-2 text-sm">{text}</p> : null;
  }

  const entries = Object.entries(payload).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-border p-2 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[8rem_1fr] gap-2 py-1">
          <span className="text-muted">{t(`proposal.payload.${k}`, { defaultValue: k })}</span>
          <span className="break-words">
            {typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? t('common.yes') : t('common.no')) : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}
