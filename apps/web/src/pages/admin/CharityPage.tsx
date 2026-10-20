import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/dates';
import { taka } from '../../lib/money';
import type { CharityDonation, CharityStatement, Page } from '../../lib/types';

export function CharityPage() {
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(String(currentYear));

  const statement = useQuery({
    queryKey: ['charity-statement', year],
    queryFn: () => api<CharityStatement>(`/charity/statement?year=${year}`),
  });

  const donations = useQuery({
    queryKey: ['charity-donations'],
    queryFn: () => api<Page<CharityDonation>>('/charity/donations'),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">{t('charityPage.title')}</h1>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('charityPage.statement')}</h2>
          <label className="text-sm text-muted">
            {t('charityPage.year')}
            <input type="number" className="ml-2 h-11 w-24 rounded-md border border-input bg-background px-2" value={year} onChange={(e) => setYear(e.target.value)} />
          </label>
        </div>
        {statement.error ? (
          <LoadError error={statement.error} onRetry={() => void statement.refetch()} />
        ) : !statement.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <dl className="grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
            <div className="rounded-md bg-background p-3">
              <dt className="text-muted">{t('charityPage.opening')}</dt>
              <dd className="text-lg font-semibold">{taka(statement.data.opening_paisa)}</dd>
            </div>
            <div className="rounded-md bg-background p-3">
              <dt className="text-muted">{t('charityPage.receipts')}</dt>
              <dd className="text-lg font-semibold">{taka(statement.data.receipts_paisa)}</dd>
            </div>
            <div className="rounded-md bg-background p-3">
              <dt className="text-muted">{t('charityPage.disbursements')}</dt>
              <dd className="text-lg font-semibold">{taka(statement.data.disbursements_paisa)}</dd>
            </div>
            <div className="rounded-md bg-background p-3">
              <dt className="text-muted">{t('charityPage.closing')}</dt>
              <dd className="text-lg font-semibold">{taka(statement.data.closing_paisa)}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <h2 className="mb-3 font-semibold">{t('charityPage.donations')}</h2>
        {donations.error ? (
          <LoadError error={donations.error} onRetry={() => void donations.refetch()} />
        ) : !donations.data ? (
          <ListSkeleton rows={3} />
        ) : donations.data.items.length === 0 ? (
          <Empty text={t('charityPage.noDonations')} />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {donations.data.items.map((d) => (
              <li key={d.id} className="flex flex-wrap justify-between gap-3 py-2">
                <div>
                  <span className="font-medium">{d.recipient}</span>
                  <span className="ml-2 text-muted">{fmtDate(d.donated_on)}</span>
                </div>
                <span className="font-semibold">{taka(d.amount_paisa)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
