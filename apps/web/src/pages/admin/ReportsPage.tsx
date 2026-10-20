import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EXPORT_ENTITIES } from '@barakah/shared';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { todayDhaka } from '../../lib/dates';
import { downloadFile } from '../../lib/download';
import type { MemberRow } from '../../lib/types';

/** Statements, exports and the annual archive: every download is written to the audit log. */
export function ReportsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [memberId, setMemberId] = useState(me?.member_id ?? '');
  const [period, setPeriod] = useState(todayDhaka().slice(0, 7));
  const [entity, setEntity] = useState<(typeof EXPORT_ENTITIES)[number]>('ledger');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [year, setYear] = useState(String(Number(todayDhaka().slice(0, 4)) - 1));
  const [error, setError] = useState<unknown>(null);
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });

  const get = async (path: string, name: string): Promise<void> => {
    setError(null);
    try {
      await downloadFile(path, name);
    } catch (err) {
      setError(err);
    }
  };
  const button = 'h-11 rounded-md bg-primary px-4 text-primary-foreground';
  const input = 'mt-1 h-11 w-full rounded-md border border-input bg-background px-2';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('reportsPage.title')}</h1>
      {error != null && <LoadError error={error} />}

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold">{t('reportsPage.statement')}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-muted">{t('common.member')}
            <select className={input} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              {members.data?.items.map((m) => <option key={m.id} value={m.id}>{m.code} {m.full_name}</option>)}
            </select>
          </label>
          <label className="text-sm text-muted">{t('reportsPage.periodHint')}
            <input className={input} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-11 / 2026" />
          </label>
          <div className="flex items-end gap-2">
            <button type="button" className={button} onClick={() => void get(`/reports/statement?member_id=${memberId}&period=${period}`, `statement-${period}.pdf`)}>{t('reportsPage.statementButton')}</button>
            <button type="button" className="h-11 rounded-md border border-border px-4 hover:bg-hover" onClick={() => void get(`/reports/zakat-statement?member_id=${memberId}`, 'zakat-statement.pdf')}>{t('reportsPage.zakatButton')}</button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold">{t('reportsPage.exports')}</h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-sm text-muted">{t('reportsPage.entity')}
            <select className={input} value={entity} onChange={(e) => setEntity(e.target.value as typeof entity)}>
              {EXPORT_ENTITIES.map((x) => <option key={x} value={x}>{t(`reportsPage.entities.${x}`)}</option>)}
            </select>
          </label>
          <label className="text-sm text-muted">{t('common.from')}<input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-sm text-muted">{t('common.to')}<input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <div className="flex items-end">
            <button type="button" className={button} onClick={() => void get(`/reports/export.csv?entity=${entity}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, `${entity}.csv`)}>{t('reportsPage.csvButton')}</button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 font-semibold">{t('reportsPage.annual')}</h2>
        <p className="mb-3 text-sm text-muted">{t('reportsPage.annualHint')}</p>
        <div className="flex items-end gap-3">
          <label className="text-sm text-muted">{t('reconcile.year')}
            <input type="number" className="mt-1 block h-11 w-28 rounded-md border border-input bg-background px-2" value={year} onChange={(e) => setYear(e.target.value)} />
          </label>
          <button type="button" className={button} onClick={() => void get(`/reports/annual?year=${year}`, `barakah-${year}.zip`)}>{t('reportsPage.zipButton')}</button>
        </div>
      </section>
    </div>
  );
}
