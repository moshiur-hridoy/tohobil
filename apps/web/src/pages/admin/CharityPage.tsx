import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, Card, CardHead, EmptyCard, ICONS, StatGrid, StatTile } from '../../components/admin';
import { localDigits } from '../../lib/format';
import { api } from '../../lib/api';
import { fmtDate, todayDhaka } from '../../lib/dates';
import { taka } from '../../lib/money';
import type { CharityDonation, CharityStatement, Page } from '../../lib/types';

export function CharityPage() {
  const { t } = useTranslation();
  const [year, setYear] = useState(todayDhaka().slice(0, 4));

  const statement = useQuery({
    queryKey: ['charity-statement', year],
    queryFn: () => api<CharityStatement>(`/charity/statement?year=${year}`),
  });

  const donations = useQuery({
    queryKey: ['charity-donations'],
    queryFn: () => api<Page<CharityDonation>>('/charity/donations'),
  });

  const st = statement.data;
  return (
    <AdminPage>
      <AdminHeader
        title={t('charityPage.title')}
        subtitle={t('adminUi.sub.charity')}
        actions={<input type="number" aria-label={t('charityPage.year')} className="field w-28" value={year} onChange={(e) => setYear(e.target.value)} />}
      />

      {statement.error && <LoadError error={statement.error} onRetry={() => void statement.refetch()} />}
      <StatGrid>
        <StatTile tone="bg-soft text-ink2" icon={ICONS.book} label={t('charityPage.opening')} value={st ? taka(st.opening_paisa) : null} sub={year} />
        <StatTile tone="bg-ok-bg text-ok" icon={ICONS.plus} label={t('charityPage.receipts')} value={st ? taka(st.receipts_paisa) : null} />
        <StatTile tone="bg-vio-bg text-vio" icon={ICONS.heart} label={t('charityPage.disbursements')} value={st ? taka(st.disbursements_paisa) : null} />
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.wallet} label={t('charityPage.closing')} value={st ? taka(st.closing_paisa) : null} />
      </StatGrid>

      <Card className="px-5 pb-3 pt-5 sm:px-6">
        <CardHead icon={ICONS.heart} tone="bg-vio-bg text-vio" title={t('charityPage.donations')} />
        {donations.error ? (
          <LoadError error={donations.error} onRetry={() => void donations.refetch()} />
        ) : !donations.data ? (
          <ListSkeleton rows={3} />
        ) : donations.data.items.length === 0 ? (
          <EmptyCard text={t('charityPage.noDonations')} icon={ICONS.heart} />
        ) : (
          <ul>
            {donations.data.items.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{d.recipient}</p>
                  <p className="text-xs text-muted">{fmtDate(d.donated_on)}{d.ledger_seq ? ` · #${localDigits(d.ledger_seq)}` : ''}</p>
                </div>
                <span className="font-bold tabular-nums">{taka(d.amount_paisa)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AdminPage>
  );
}
