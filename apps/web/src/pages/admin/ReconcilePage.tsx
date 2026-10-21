import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tryParseBDT } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, Card, CardHead, ICONS, SplitLayout, StatGrid, StatTile } from '../../components/admin';
import { Icon } from '../../components/ui';
import { formatCount, localDigits } from '../../lib/format';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtPeriod, todayDhaka } from '../../lib/dates';
import { downloadFile } from '../../lib/download';
import { taka } from '../../lib/money';

const ACCOUNTS = ['CASH', 'BANK', 'BKASH', 'NAGAD'] as const;

interface Row {
  account: string;
  system_balance_paisa: string;
  actual_balance_paisa: string;
  difference_paisa: string;
  note: string | null;
  approved_at: string | null;
}
interface PeriodRow {
  period: string;
  locked_at: string | null;
  counted_accounts: number;
  approved_accounts: number;
  open_objections: number;
}

function previousMonth(): string {
  const [y, m] = todayDhaka().split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

type Sheet = 'submit' | 'approve' | 'lock' | 'request' | 'signoff' | 'archive' | null;

/** Month-end cash count, the auditor's approval and lock, and the year-end audit and archive (spec 5.12). */
export function ReconcilePage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const isAuditor = me?.roles.includes('auditor') ?? false;
  const [period, setPeriod] = useState(previousMonth());
  const [year, setYear] = useState(previousMonth().slice(0, 4));
  const [sheet, setSheet] = useState<Sheet>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const rows = useQuery({ queryKey: ['reconciliations', period], queryFn: () => api<{ items: Row[] }>(`/reconciliations?period=${period}`) });
  const periods = useQuery({ queryKey: ['periods', year], queryFn: () => api<{ items: PeriodRow[] }>(`/periods?year=${year}`) });
  const audit = useQuery({ queryKey: ['audit', year], queryFn: () => api<{ status: string; signed_at: string | null }>(`/periods/${year}/audit`) });

  const refresh = () => void qc.invalidateQueries();
  const month = periods.data?.items.find((p) => p.period === period);
  const approved = (rows.data?.items.length ?? 0) === 4 && rows.data?.items.every((r) => r.approved_at);
  const counted = (rows.data?.items.length ?? 0) === 4;
  const locked = periods.data?.items.filter((p) => p.locked_at).length ?? 0;
  const countsValid = ACCOUNTS.every((a) => tryParseBDT((counts[a] ?? '').trim()) !== null);

  const run = async (): Promise<void> => {
    if (sheet === 'submit') {
      await api('/reconciliations', {
        method: 'POST',
        body: {
          period,
          entries: ACCOUNTS.map((a) => ({ account: a, actual_balance_paisa: String(tryParseBDT((counts[a] ?? '').trim())), ...(notes[a]?.trim() ? { note: notes[a]!.trim() } : {}) })),
        },
      });
    } else if (sheet === 'approve') await api(`/reconciliations/${period}/approve`, { method: 'POST' });
    else if (sheet === 'lock') await api(`/periods/${period}/lock`, { method: 'POST' });
    else if (sheet === 'request') await api(`/periods/${year}/audit-request`, { method: 'POST' });
    else if (sheet === 'signoff') await api(`/periods/${year}/audit-signoff`, { method: 'POST' });
    else if (sheet === 'archive') await api(`/periods/${year}/archive`, { method: 'POST' });
    refresh();
  };

  const button = (label: string, which: Sheet, enabled: boolean) =>
    enabled && (
      <button type="button" onClick={() => setSheet(which)} className={BTN_PRIMARY}>{label}</button>
    );
  const items = rows.data?.items ?? [];
  // absolute values: a shortfall in one account must not hide behind a surplus in another
  const difference = items.reduce((n, r) => {
    const d = BigInt(r.difference_paisa);
    return n + (d < 0n ? -d : d);
  }, 0n);
  const auditStatus = audit.data?.status ?? 'none';

  return (
    <AdminPage>
      <AdminHeader
        title={t('reconcile.title')}
        subtitle={t('adminUi.sub.reconcile')}
        actions={<input type="month" aria-label={t('reconcile.month')} value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="field w-[10.5rem]" />}
      />

      <StatGrid>
        <StatTile tone={counted ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'} icon={ICONS.wallet} label={t('adminUi.reconcile.statCounted')}
          value={rows.data ? `${formatCount(items.length)}/${formatCount(ACCOUNTS.length)}` : null}
          sub={fmtPeriod(period)} />
        <StatTile tone={difference !== 0n ? 'bg-bad-bg text-bad' : 'bg-primary-soft text-primary'} icon={ICONS.scale} label={t('adminUi.reconcile.statDifference')}
          value={rows.data ? (counted ? taka(difference) : '—') : null} valueClass={difference !== 0n ? 'text-bad' : ''} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.lock} label={t('adminUi.reconcile.statLocked')}
          value={periods.data ? `${formatCount(locked)}/${formatCount(12)}` : null} sub={localDigits(year)} />
        <StatTile tone={auditStatus === 'approved' ? 'bg-ok-bg text-ok' : 'bg-soft text-ink2'} icon={ICONS.shield} label={t('adminUi.reconcile.statAudit')}
          value={audit.data ? <span className="text-base">{t(`reconcile.auditStatus.${auditStatus}`)}</span> : null} sub={localDigits(year)} />
      </StatGrid>

      <SplitLayout
        main={
          <Card className="p-5 sm:px-6">
            <CardHead icon={ICONS.wallet} title={t('reconcile.count')} sub={t('reconcile.countHint')} />
            {rows.error ? (
              <LoadError error={rows.error} onRetry={() => void rows.refetch()} />
            ) : !rows.data ? (
              <ListSkeleton rows={4} />
            ) : (
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr className="text-xs font-semibold text-muted">
                      <th className="border-b border-border px-2 py-2.5 text-left">{t('reconcile.account')}</th>
                      <th className="border-b border-border px-2 py-2.5 text-right">{t('reconcile.books')}</th>
                      <th className="border-b border-border px-2 py-2.5 text-right">{t('reconcile.counted')}</th>
                      <th className="border-b border-border px-2 py-2.5 text-right">{t('reconcile.difference')}</th>
                      {isCashier && !approved && <th className="border-b border-border px-2 py-2.5 text-left">{t('reconcile.newCount')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {ACCOUNTS.map((a) => {
                      const r = items.find((x) => x.account === a);
                      const off = r && r.difference_paisa !== '0';
                      return (
                        <tr key={a}>
                          <td className="border-b border-border px-2 py-3 font-semibold">{t(`cashAccount.${a}`)}</td>
                          <td className="border-b border-border px-2 py-3 text-right tabular-nums">{r ? taka(r.system_balance_paisa) : '—'}</td>
                          <td className="border-b border-border px-2 py-3 text-right tabular-nums">{r ? taka(r.actual_balance_paisa) : '—'}</td>
                          <td className={`border-b border-border px-2 py-3 text-right tabular-nums ${off ? 'font-semibold text-bad' : 'text-muted'}`}>
                            {r ? taka(r.difference_paisa) : '—'}
                            {r?.note && <div className="text-xs font-normal text-muted">{r.note}</div>}
                          </td>
                          {isCashier && !approved && (
                            <td className="border-b border-border px-2 py-2">
                              <div className="flex gap-2">
                                <input aria-label={`${a} ${t('reconcile.counted')}`} inputMode="decimal" className="field w-28" value={counts[a] ?? ''} onChange={(e) => setCounts({ ...counts, [a]: e.target.value })} />
                                <input aria-label={`${a} ${t('assetsAdmin.note')}`} placeholder={t('assetsAdmin.note')} className="field w-40" value={notes[a] ?? ''} onChange={(e) => setNotes({ ...notes, [a]: e.target.value })} />
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {isCashier && !approved && button(t('reconcile.submit'), 'submit', countsValid)}
              {isAuditor && button(t('reconcile.approve'), 'approve', counted && !approved)}
              {isAuditor && button(t('reconcile.lock'), 'lock', !!approved && !month?.locked_at)}
              {month?.locked_at && <StatusPill status="confirmed" label={t('reconcile.locked')} />}
              {(month?.open_objections ?? 0) > 0 && <span className="text-sm font-medium text-warn">{t('reconcile.openObjections', { count: month!.open_objections })}</span>}
            </div>
          </Card>
        }
        side={
          <Card className="p-5">
            <CardHead
              icon={ICONS.lock}
              tone="bg-blue-bg text-blue"
              title={t('reconcile.yearEnd')}
              action={<input type="number" aria-label={t('reconcile.year')} value={year} onChange={(e) => setYear(e.target.value)} className="field w-24" />}
            />
            <ol className="space-y-0">
              {([
                [t('reconcile.lockedMonths', { count: locked }), locked === 12],
                [`${t('reconcile.audit')}: ${t(`reconcile.auditStatus.${auditStatus}`)}`, auditStatus === 'approved'],
              ] as const).map(([label, ok]) => (
                <li key={label} className="flex min-h-11 items-center gap-3 border-t border-border text-sm first:border-t-0">
                  <span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${ok ? 'bg-ok-bg text-ok' : 'bg-soft text-muted'}`}>{ok ? '✓' : '•'}</span>
                  <span className={ok ? 'font-semibold' : 'text-ink2'}>{label}</span>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-col gap-2">
              {isCashier && button(t('reconcile.requestAudit'), 'request', locked === 12 && auditStatus === 'none')}
              {isAuditor && button(t('reconcile.signAudit'), 'signoff', auditStatus === 'pending')}
              {isCashier && button(t('reconcile.createArchive'), 'archive', auditStatus === 'approved')}
              {auditStatus === 'approved' && (
                <button type="button" onClick={() => void downloadFile(`/reports/annual?year=${year}`, `barakah-${year}.zip`).catch(() => undefined)} className={BTN_SECONDARY}>
                  <Icon d={ICONS.download} size={18} />
                  {t('reconcile.downloadArchive')}
                </button>
              )}
            </div>
            <p className="mt-3 text-xs text-muted">{t('reconcile.yearHint')}</p>
          </Card>
        }
      />

      <ConfirmSheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet ? t(`reconcile.sheet.${sheet}`) : ''}
        confirmLabel={t('common.confirm')}
        onConfirm={run}
      >
        <p className="text-muted">{sheet === 'submit' || sheet === 'approve' || sheet === 'lock' ? period : year}</p>
        {sheet === 'lock' && <p className="text-sm text-muted">{t('reconcile.lockWarning')}</p>}
        {sheet === 'archive' && <p className="text-sm text-muted">{t('reconcile.archiveWarning')}</p>}
      </ConfirmSheet>
    </AdminPage>
  );
}
