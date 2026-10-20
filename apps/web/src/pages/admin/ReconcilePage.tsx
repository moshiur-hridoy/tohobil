import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tryParseBDT } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { todayDhaka } from '../../lib/dates';
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
      <button type="button" onClick={() => setSheet(which)} className="h-10 rounded-md bg-primary px-4 text-primary-foreground">{label}</button>
    );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('reconcile.title')}</h1>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('reconcile.count')}</h2>
          <input type="month" aria-label={t('reconcile.month')} value={period} onChange={(e) => setPeriod(e.target.value)} className="h-11 rounded-md border border-input bg-background px-2" />
        </div>
        <p className="mb-3 text-sm text-muted">{t('reconcile.countHint')}</p>
        {rows.error ? (
          <LoadError error={rows.error} onRetry={() => void rows.refetch()} />
        ) : !rows.data ? (
          <ListSkeleton rows={4} />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted">
              <tr>
                <th className="p-2 text-left">{t('reconcile.account')}</th>
                <th className="p-2 text-right">{t('reconcile.books')}</th>
                <th className="p-2 text-right">{t('reconcile.counted')}</th>
                <th className="p-2 text-right">{t('reconcile.difference')}</th>
                {isCashier && !approved && <th className="p-2 text-left">{t('reconcile.newCount')}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ACCOUNTS.map((a) => {
                const r = rows.data.items.find((x) => x.account === a);
                return (
                  <tr key={a}>
                    <td className="p-2">{t(`cashAccount.${a}`)}</td>
                    <td className="p-2 text-right">{r ? taka(r.system_balance_paisa) : '—'}</td>
                    <td className="p-2 text-right">{r ? taka(r.actual_balance_paisa) : '—'}</td>
                    <td className={`p-2 text-right ${r && r.difference_paisa !== '0' ? 'font-semibold text-bad' : ''}`}>
                      {r ? taka(r.difference_paisa) : '—'}
                      {r?.note && <div className="text-xs font-normal text-muted">{r.note}</div>}
                    </td>
                    {isCashier && !approved && (
                      <td className="p-2">
                        <input aria-label={`${a} ${t('reconcile.counted')}`} inputMode="decimal" className="h-9 w-28 rounded-md border border-input bg-background px-2" value={counts[a] ?? ''} onChange={(e) => setCounts({ ...counts, [a]: e.target.value })} />
                        <input aria-label={`${a} ${t('assetsAdmin.note')}`} placeholder={t('assetsAdmin.note')} className="ml-2 h-9 w-40 rounded-md border border-input bg-background px-2" value={notes[a] ?? ''} onChange={(e) => setNotes({ ...notes, [a]: e.target.value })} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {isCashier && !approved && button(t('reconcile.submit'), 'submit', countsValid)}
          {isAuditor && button(t('reconcile.approve'), 'approve', counted && !approved)}
          {isAuditor && button(t('reconcile.lock'), 'lock', !!approved && !month?.locked_at)}
          {month?.locked_at && <span className="font-medium text-ok">{t('reconcile.locked')}</span>}
          {(month?.open_objections ?? 0) > 0 && <span className="text-warn">{t('reconcile.openObjections', { count: month!.open_objections })}</span>}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('reconcile.yearEnd')}</h2>
          <input type="number" aria-label={t('reconcile.year')} value={year} onChange={(e) => setYear(e.target.value)} className="h-11 w-28 rounded-md border border-input bg-background px-2" />
        </div>
        <p className="text-sm text-muted">{t('reconcile.lockedMonths', { count: locked })} · {t('reconcile.audit')}: {t(`reconcile.auditStatus.${audit.data?.status ?? 'none'}`)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {isCashier && button(t('reconcile.requestAudit'), 'request', locked === 12 && audit.data?.status === 'none')}
          {isAuditor && button(t('reconcile.signAudit'), 'signoff', audit.data?.status === 'pending')}
          {isCashier && button(t('reconcile.createArchive'), 'archive', audit.data?.status === 'approved')}
          {audit.data?.status === 'approved' && (
            <button type="button" onClick={() => void downloadFile(`/reports/annual?year=${year}`, `barakah-${year}.zip`).catch(() => undefined)} className="h-10 rounded-md border border-border px-4 hover:bg-hover">{t('reconcile.downloadArchive')}</button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">{t('reconcile.yearHint')}</p>
      </section>

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
    </div>
  );
}
