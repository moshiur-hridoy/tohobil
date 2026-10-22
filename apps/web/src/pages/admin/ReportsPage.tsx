import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EXPORT_ENTITIES } from '@barakah/shared';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, Card, CardHead, FieldLabel, ICONS } from '../../components/admin';
import { Icon, DateInput } from '../../components/ui';
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
  return (
    <AdminPage>
      <AdminHeader title={t('reportsPage.title')} subtitle={t('adminUi.sub.reports')} />
      {error != null && <LoadError error={error} />}

      <div className="grid items-start gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        <Card className="p-5">
          <CardHead icon={ICONS.user} title={t('reportsPage.statement')} />
          <div className="space-y-3">
            <FieldLabel label={t('common.member')}>
              <select className="field w-full" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                {members.data?.items.map((m) => <option key={m.id} value={m.id}>{m.code} {m.full_name}</option>)}
              </select>
            </FieldLabel>
            <FieldLabel label={t('reportsPage.periodHint')}>
              <input className="field w-full" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-11 / 2026" />
            </FieldLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" className={BTN_PRIMARY} onClick={() => void get(`/reports/statement?member_id=${memberId}&period=${period}`, `statement-${period}.pdf`)}>
                <Icon d={ICONS.download} size={18} />
                {t('reportsPage.statementButton')}
              </button>
              <button type="button" className={BTN_SECONDARY} onClick={() => void get(`/reports/zakat-statement?member_id=${memberId}`, 'zakat-statement.pdf')}>{t('reportsPage.zakatButton')}</button>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <CardHead icon={ICONS.grid} tone="bg-blue-bg text-blue" title={t('reportsPage.exports')} />
          <div className="space-y-3">
            <FieldLabel label={t('reportsPage.entity')}>
              <select className="field w-full" value={entity} onChange={(e) => setEntity(e.target.value as typeof entity)}>
                {EXPORT_ENTITIES.map((x) => <option key={x} value={x}>{t(`reportsPage.entities.${x}`)}</option>)}
              </select>
            </FieldLabel>
            <div className="grid grid-cols-2 gap-3">
              <FieldLabel label={t('common.from')}><DateInput className="field w-full" value={from} onChange={(e) => setFrom(e.target.value)} /></FieldLabel>
              <FieldLabel label={t('common.to')}><DateInput className="field w-full" value={to} onChange={(e) => setTo(e.target.value)} /></FieldLabel>
            </div>
            <button type="button" className={`${BTN_PRIMARY} w-full`} onClick={() => void get(`/reports/export.csv?entity=${entity}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, `${entity}.csv`)}>
              <Icon d={ICONS.download} size={18} />
              {t('reportsPage.csvButton')}
            </button>
          </div>
        </Card>

        <Card className="p-5">
          <CardHead icon={ICONS.lock} tone="bg-warn-bg text-warn" title={t('reportsPage.annual')} sub={t('reportsPage.annualHint')} />
          <div className="space-y-3">
            <FieldLabel label={t('reconcile.year')}>
              <input type="number" className="field w-full" value={year} onChange={(e) => setYear(e.target.value)} />
            </FieldLabel>
            <button type="button" className={`${BTN_PRIMARY} w-full`} onClick={() => void get(`/reports/annual?year=${year}`, `barakah-${year}.zip`)}>
              <Icon d={ICONS.download} size={18} />
              {t('reportsPage.zipButton')}
            </button>
          </div>
        </Card>
      </div>
    </AdminPage>
  );
}
