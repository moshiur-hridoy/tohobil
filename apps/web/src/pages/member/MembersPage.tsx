import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { formatCount } from '../../lib/format';
import { arrearsOf, taka } from '../../lib/money';
import type { MemberRow } from '../../lib/types';

interface RegisterRow {
  share_no: number;
  member_id: string;
  registered_name: string;
  nominee_name: string | null;
  nominee_relation: string | null;
}

/** Members and the informational share register (spec 8: Menu > members and shares list). */
export function MembersPage() {
  const { t } = useTranslation();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const register = useQuery({ queryKey: ['share-register'], queryFn: () => api<{ items: RegisterRow[]; total: number }>('/share-register') });

  if (members.error) return <div className="p-4"><LoadError error={members.error} onRetry={() => void members.refetch()} /></div>;

  return (
    <div className="space-y-3 p-4">
      <header>
        <h2 className="text-lg font-semibold">{t('membersPage.title')}</h2>
        {register.data && <p className="text-muted">{t('membersPage.total', { total: formatCount(register.data.total) })}</p>}
      </header>
      {!members.data ? (
        <ListSkeleton rows={5} />
      ) : members.data.items.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <ul className="space-y-2">
          {members.data.items.map((m) => {
            const mine = register.data?.items.filter((r) => r.member_id === m.id) ?? [];
            return (
              <li key={m.id} className="rounded-[18px] border border-border bg-card shadow-card p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{m.code} · {m.full_name}</span>
                  <span className="text-sm text-muted">{t(`status.member.${m.status}`, { defaultValue: m.status })}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-sm">
                  <span>{t('membersPage.shares')}: {formatCount(m.shares)}</span>
                  <span>{t('membersPage.capital')}: {taka(m.capital_paisa)}</span>
                  <span>{t('membersPage.outstanding')}: {taka(arrearsOf(m))}</span>
                </div>
                {mine.length > 0 && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-primary">{t('membersPage.register')}</summary>
                    <ul className="mt-1 space-y-1">
                      {mine.map((r) => (
                        <li key={r.share_no}>
                          #{formatCount(r.share_no)} · {r.registered_name}
                          {r.nominee_name && <span className="text-muted"> · {t('membersPage.nominee')}: {r.nominee_name}{r.nominee_relation ? ` (${r.nominee_relation})` : ''}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
