import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadFile } from '../../lib/download';

interface DeviceEvent {
  id: string;
  kind: 'registered' | 'revoked' | 'reset';
  at: string;
  member_code: string;
  full_name: string;
}

interface DeviceRow {
  id: string;
  label: string | null;
  platform: string;
  current: boolean;
}

export function MenuPage() {
  const { t } = useTranslation();
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  const events = useQuery({ queryKey: ['device-events'], queryFn: () => api<{ items: DeviceEvent[] }>('/device-events') });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<{ items: DeviceRow[] }>('/me/devices') });

  const privileged = !!me?.roles.some((r) => r === 'cashier' || r === 'auditor');
  const stepUpActive = !!me?.step_up_until;

  return (
    <div className="space-y-4 p-4">
      {me && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-lg font-semibold">{me.full_name}</p>
          <p className="text-muted">
            {me.member_code} · {me.roles.map((r) => t(`roles.${r}`)).join(', ')}
          </p>
          {me.read_only && <p className="mt-2 text-warn">{t('errors.auth.read_only')}</p>}
        </div>
      )}

      <nav className="grid gap-3" aria-label={t('nav.menu')}>
        <Link to="/menu/notices" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('menuLinks.notices')}</span>
          <span className="block text-sm text-muted">{t('menuLinks.noticesHint')}</span>
        </Link>
        <Link to="/menu/pin" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('pinChange.title')}</span>
          <span className="block text-sm text-muted">{t('pinChange.hint')}</span>
        </Link>
        <Link to="/menu/constitution" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('menuLinks.constitution')}</span>
          <span className="block text-sm text-muted">{t('menuLinks.constitutionHint')}</span>
        </Link>
        <Link to="/menu/ledger" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('menuLinks.ledger')}</span>
          <span className="block text-sm text-muted">{t('menuLinks.ledgerHint')}</span>
        </Link>
        <Link to="/menu/members" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('menuLinks.members')}</span>
          <span className="block text-sm text-muted">{t('menuLinks.membersHint')}</span>
        </Link>
        <Link to="/menu/settlement" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('menuLinks.settlement')}</span>
          <span className="block text-sm text-muted">{t('menuLinks.settlementHint')}</span>
        </Link>
        <Link to="/menu/constitution" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('menuLinks.constitution')}</span>
          <span className="block text-sm text-muted">{t('menuLinks.constitutionHint')}</span>
        </Link>
      </nav>

      {privileged && (
        <Link to="/totp" className="block rounded-lg border border-border bg-card p-4">
          <span className="font-medium">{t('totp.title')}</span>
          <span className={`block text-sm ${stepUpActive ? 'text-ok' : 'text-warn'}`}>
            {me?.totp_enabled ? (stepUpActive ? t('totp.active') : t('totp.needed')) : t('totp.notEnrolled')}
          </span>
        </Link>
      )}

      <MyStatements />

      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 font-semibold">{t('menu.devices')}</h2>
        <ul className="space-y-1">
          {devices.data?.items.map((d) => (
            <li key={d.id} className="flex justify-between text-sm">
              <span>{d.label ?? d.platform}</span>
              {d.current && <span className="text-ok">{t('menu.thisDevice')}</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 font-semibold">{t('menu.securityFeed')}</h2>
        <p className="mb-2 text-sm text-muted">{t('menu.securityFeedHint')}</p>
        <ul className="space-y-1 text-sm">
          {events.data?.items.slice(0, 20).map((e) => (
            <li key={e.id}>
              <span className="font-medium">{e.member_code}</span> · {t(`menu.deviceEvent.${e.kind}`)} ·{' '}
              <time dateTime={e.at} className="text-muted">
                {new Date(e.at).toLocaleDateString('bn-BD', { timeZone: 'Asia/Dhaka' })}
              </time>
            </li>
          ))}
          {events.data?.items.length === 0 && <li className="text-muted">{t('menu.noEvents')}</li>}
        </ul>
      </div>

      <button
        type="button"
        onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
        className="h-12 w-full rounded-md border border-border bg-card font-medium text-bad"
      >
        {t('menu.logout')}
      </button>
    </div>
  );
}

/** The member's own statement and zakat information as PDFs. */
function MyStatements() {
  const { t } = useTranslation();
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [error, setError] = useState<unknown>(null);
  const get = async (path: string, name: string): Promise<void> => {
    setError(null);
    try {
      await downloadFile(path, name);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-1 font-semibold">{t('menuReports.title')}</h2>
      <p className="mb-3 text-sm text-muted">{t('menuReports.hint')}</p>
      <label className="block text-sm text-muted">
        {t('menuReports.year')}
        <input type="number" className="mt-1 h-11 w-28 rounded-md border border-input bg-background px-2" value={year} onChange={(e) => setYear(e.target.value)} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void get(`/reports/statement?period=${year}`, `statement-${year}.pdf`)} className="h-11 rounded-md bg-primary px-4 text-primary-foreground">{t('menuReports.statement')}</button>
        <button type="button" onClick={() => void get('/reports/zakat-statement', 'zakat-statement.pdf')} className="h-11 rounded-md border border-border px-4">{t('menuReports.zakat')}</button>
      </div>
      {error != null && <div className="mt-3"><LoadError error={error} /></div>}
    </div>
  );
}
