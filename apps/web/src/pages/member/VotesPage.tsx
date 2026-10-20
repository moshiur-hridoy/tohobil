import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { ListSkeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useCountdown } from '../../lib/countdown';
import { fmtInstant } from '../../lib/dates';
import type { ProposalSummary } from '../../lib/types';

const LIMIT = 200;
const FINAL_STATUSES = new Set(['approved', 'rejected', 'executed', 'lapsed', 'cancelled']);

export function VotesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const proposals = useQuery({
    queryKey: ['proposals', 'member'],
    queryFn: () => api<{ items: ProposalSummary[]; next_cursor: string | null }>(`/proposals?limit=${LIMIT}`),
  });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['proposals'] })]);

  const open = proposals.data?.items.filter((p) => p.status === 'open') ?? [];
  const past = proposals.data?.items.filter((p) => FINAL_STATUSES.has(p.status)) ?? [];

  return (
    <PullToRefresh onRefresh={refresh}>
      <PageHeader title={t('votes.title')} />
      <div className="space-y-4 px-4 pb-4 pt-2">

        {proposals.error ? (
          <LoadError error={proposals.error} onRetry={() => void proposals.refetch()} />
        ) : !proposals.data ? (
          <ListSkeleton rows={4} />
        ) : proposals.data.items.length === 0 ? (
          <Empty text={t('common.noData')} />
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="px-1 text-sm font-semibold text-ink2">{t('votes.open')}</h3>
              {open.length === 0 ? (
                <p className="text-muted">{t('votes.openCount', { count: 0 })}</p>
              ) : (
                open.map((p) => <ProposalCard key={p.id} proposal={p} />)
              )}
            </section>

            {past.length > 0 && (
              <section className="space-y-2">
                <h3 className="px-1 text-sm font-semibold text-ink2">{t('votes.past')}</h3>
                {past.map((p) => (
                  <ProposalCard key={p.id} proposal={p} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </PullToRefresh>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalSummary }) {
  const { t } = useTranslation();
  const remaining = useCountdown(proposal.closes_at ?? null);
  return (
    <Link
      to={`/votes/${proposal.id}`}
      data-testid="proposal-card"
      className="block rounded-[20px] border border-border bg-card p-4 shadow-card hover:bg-hover"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-bold leading-snug">{proposal.title}</p>
          <p className="text-sm text-muted">
            {t(`proposalType.${proposal.type}`)} · {t('votes.deadline')}: {remaining ?? fmtInstant(proposal.created_at)}
          </p>
        </div>
        <span className="shrink-0">
          {proposal.status === 'open' ? (
            <StatusPill status="pending" label={t(`status.proposal.${proposal.status}`)} />
          ) : (
            <StatusPill status={proposal.status} label={t(`status.proposal.${proposal.status}`)} />
          )}
        </span>
      </div>
      <div className="mt-3 rounded-xl bg-background px-3 py-2 text-sm">
        {proposal.ballots_hidden ? (
          <span className="text-muted">{t('votes.hiddenUntilClose')}</span>
        ) : (
          <>
            <span className="text-muted">{t('votes.result')}:</span>{' '}
            <span className="font-medium">
              {proposal.basis === 'share'
                ? `${proposal.counts.yes_weight} / ${proposal.threshold_weight}`
                : `${proposal.counts.yes} / ${proposal.threshold}`}
            </span>
          </>
        )}
      </div>
    </Link>
  );
}
