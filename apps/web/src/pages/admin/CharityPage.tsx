import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, Card, CardHead, EmptyCard, ICONS, MemberBadge, Segmented, StatGrid, StatTile } from '../../components/admin';
import { Chip } from '../../components/ui';
import { localDigits } from '../../lib/format';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/dates';
import { taka } from '../../lib/money';
import type { CharityEntry, CharityStatement, FundExpenses } from '../../lib/types';

/** One charity fund movement: what it was, who or where, and the amount in or out. */
function EntryRow({ e }: { e: CharityEntry }) {
  const { t } = useTranslation();
  const into = e.direction === 'in';
  const who = e.member_code ? e.member_name : e.recipient ?? e.memo;
  return (
    <li className="flex items-center gap-3 border-b border-border py-3 last:border-b-0">
      {e.member_code ? (
        <MemberBadge code={e.member_code} />
      ) : (
        <Chip tone={into ? 'bg-ok-bg text-ok' : 'bg-vio-bg text-vio'} d={into ? ICONS.plus : ICONS.heart} size={32} iconSize={16} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{t(`charityPage.kind.${e.kind}`)}{who ? ` · ${who}` : ''}</p>
        <p className="text-xs text-muted">{fmtDate(e.entry_date)} · #{localDigits(e.seq)}</p>
      </div>
      <span className={`font-bold tabular-nums ${into ? 'text-ok' : 'text-vio'}`}>
        {into ? '+' : '−'}{taka(e.amount_paisa)}
      </span>
    </li>
  );
}

/** The fund's own expenses (bank and SMS charges and the like), from the start, kept apart from charity. */
function ExpensesTab({ query }: { query: UseQueryResult<FundExpenses> }) {
  const { t } = useTranslation();
  const ex = query.data;
  return (
    <Card className="px-5 pb-3 pt-5 sm:px-6">
      <CardHead icon={ICONS.wallet} tone="bg-soft text-ink2" title={t('charityPage.fundExpenses')} sub={t('charityPage.fundExpensesSub')} />
      {query.error ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : !ex ? (
        <ListSkeleton rows={2} />
      ) : ex.items.length === 0 ? (
        <EmptyCard text={t('charityPage.noExpenses')} icon={ICONS.wallet} />
      ) : (
        <ul>
          {ex.items.map((x) => (
            <li key={x.seq} className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
              <div className="min-w-0">
                <p className="truncate font-semibold">{t(`charityPage.account.${x.account}`)}{x.memo ? ` · ${x.memo.replace(/ \(legacy import\)$/, '')}` : ''}</p>
                <p className="text-xs text-muted">{fmtDate(x.entry_date)} · #{localDigits(x.seq)}</p>
              </div>
              <span className="font-bold tabular-nums">{taka(x.amount_paisa)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Every fine, bank profit and donation of the charity fund, from the start. */
function CharityTab({ query }: { query: UseQueryResult<CharityStatement> }) {
  const { t } = useTranslation();
  const st = query.data;
  return (
    <Card className="px-5 pb-3 pt-5 sm:px-6">
      <CardHead icon={ICONS.heart} tone="bg-vio-bg text-vio" title={t('charityPage.charityFund')} sub={t('charityPage.charityFundSub')} />
      {query.error ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : !st ? (
        <ListSkeleton rows={3} />
      ) : st.entries.length === 0 ? (
        <EmptyCard text={t('charityPage.noEntries')} icon={ICONS.heart} />
      ) : (
        <ul>
          {st.entries.map((e) => <EntryRow key={e.seq} e={e} />)}
        </ul>
      )}
    </Card>
  );
}

export function CharityPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'charity' | 'expenses'>('charity');

  // Both from the start: the owner reads this page as "what came in, what went out, what is left".
  const statement = useQuery({
    queryKey: ['charity-statement', 'all'],
    queryFn: () => api<CharityStatement>('/charity/statement'),
  });
  const expenses = useQuery({
    queryKey: ['fund-expenses'],
    queryFn: () => api<FundExpenses>('/charity/expenses'),
  });
  const st = statement.data;
  const ex = expenses.data;

  return (
    <AdminPage>
      <AdminHeader
        title={t('charityPage.title')}
        subtitle={t('adminUi.sub.charity')}
        actions={
          <Segmented
            label={t('charityPage.tabs')}
            value={tab}
            options={[
              { value: 'charity', label: t('charityPage.tabCharity') },
              { value: 'expenses', label: t('charityPage.tabExpenses') },
            ]}
            onChange={setTab}
          />
        }
      />

      <StatGrid>
        <StatTile tone="bg-ok-bg text-ok" icon={ICONS.plus} label={t('charityPage.totalFund')} value={st ? taka(st.receipts_paisa) : null} sub={t('charityPage.totalFundSub')} />
        <StatTile tone="bg-soft text-ink2" icon={ICONS.wallet} label={t('charityPage.totalExpenses')} value={ex ? taka(ex.total_paisa) : null} sub={t('charityPage.totalExpensesSub')} />
        <StatTile tone="bg-vio-bg text-vio" icon={ICONS.heart} label={t('charityPage.totalDonated')} value={st ? taka(st.disbursements_paisa) : null} sub={t('charityPage.allTime')} />
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.book} label={t('charityPage.inHand')} value={st ? taka(st.closing_paisa) : null} sub={t('charityPage.inHandSub')} />
      </StatGrid>

      {tab === 'charity' ? <CharityTab query={statement} /> : <ExpensesTab query={expenses} />}
    </AdminPage>
  );
}
