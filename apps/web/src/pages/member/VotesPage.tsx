import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Segmented } from '../../components/admin';
import { ProposalVoteCard } from '../../components/ProposalVoteCard';
import { PageHeader } from '../../components/ui';
import { ListSkeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { formatCount } from '../../lib/format';
import type { ProposalSummary } from '../../lib/types';

const LIMIT = 200;
const FINAL_STATUSES = new Set(['approved', 'rejected', 'executed', 'lapsed', 'cancelled']);

/** The page opens on the running votes (owner); `all` adds the finished ones below them. */
const TABS = ['active', 'all'] as const;
type Tab = (typeof TABS)[number];

export function VotesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('active');

  const proposals = useQuery({
    queryKey: ['proposals', 'member'],
    queryFn: () => api<{ items: ProposalSummary[]; next_cursor: string | null }>(`/proposals?limit=${LIMIT}`),
  });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['proposals'] })]);

  const open = proposals.data?.items.filter((p) => p.status === 'open') ?? [];
  const past = proposals.data?.items.filter((p) => FINAL_STATUSES.has(p.status)) ?? [];
  const lists: Record<Tab, ProposalSummary[]> = { active: open, all: [...open, ...past] };
  const shown = lists[tab];

  return (
    <PullToRefresh onRefresh={refresh}>
      <PageHeader title={t('votes.title')} />
      <div className="space-y-4 px-4 pb-4 pt-2">

        <Segmented
          wide
          label={t('common.status')}
          value={tab}
          onChange={setTab}
          options={TABS.map((value) => ({
            value,
            label: t(`proposalsPage.tabs.${value}`),
            count: proposals.data ? formatCount(lists[value].length) : undefined,
          }))}
        />

        {proposals.error ? (
          <LoadError error={proposals.error} onRetry={() => void proposals.refetch()} />
        ) : !proposals.data ? (
          <ListSkeleton rows={4} />
        ) : shown.length === 0 ? (
          <Empty text={t(tab === 'active' ? 'votes.noOpen' : 'common.noData')} />
        ) : (
          <div className="space-y-2">
            {shown.map((p) => (
              <ProposalVoteCard key={p.id} proposal={p} />
            ))}
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
