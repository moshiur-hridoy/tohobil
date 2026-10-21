import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Icon, PageHeader } from '../../components/ui';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadFile } from '../../lib/download';
import { ThemeToggle } from '../../components/ThemeToggle';

const CARD = 'rounded-[20px] border border-border bg-card p-4';

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

  const tiles = [
    { to: '/menu/constitution', label: t('menuLinks.constitution'), tone: 'bg-blue-bg text-blue', d: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h11' },
    { to: '/menu/notices', label: t('menuLinks.notices'), tone: 'bg-warn-bg text-warn', d: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7 M10 20a2 2 0 0 0 4 0' },
    { to: '/menu/ledger', label: t('menuLinks.ledger'), tone: 'bg-primary-soft text-primary', d: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 13h6 M9 17h6' },
    { to: '/menu/settlement', label: t('menuLinks.settlement'), tone: 'bg-vio-bg text-vio', d: 'M4 12h12 M12 7l5 5-5 5 M20 5v14' },
    { to: '/menu/members', label: t('menuLinks.members'), tone: 'bg-primary-soft text-primary', d: 'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M20 20v-1a4 4 0 0 0-3-3.8 M16 4.2a3.5 3.5 0 0 1 0 6.6' },
    { to: '/menu/pin', label: t('pinChange.title'), tone: 'bg-blue-bg text-blue', d: 'M6 11V8a6 6 0 0 1 12 0v3 M5 11h14v10H5z' },
  ];

  return (
    <div>
      <PageHeader title={t('nav.menu')} />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
      {me && (
        <section className={CARD + ' flex flex-wrap items-center gap-x-3 gap-y-1'}>
          <div className="grid h-[50px] w-[50px] shrink-0 place-items-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
            {me.full_name.trim().charAt(0)}
          </div>
          <div className="min-w-[6rem] flex-1">
            <p className="truncate text-[1.0625rem] font-bold">{me.full_name}</p>
            <p className="text-[0.8125rem] text-muted">
              {me.member_code} · {me.roles.map((r) => t(`roles.${r}`)).join(', ')}
            </p>
          </div>
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void logout().then(() => navigate('/login', { replace: true }))}
            className="flex min-h-11 items-center gap-1.5 text-[0.8125rem] font-bold text-bad"
          >
            <Icon d="M9 4H5v16h4 M16 8l4 4-4 4 M20 12H9" size={18} />
            {t('menu.logout')}
          </button>
        </section>
      )}
      {me?.read_only && <p className="rounded-xl bg-warn-bg p-3 text-sm text-warn">{t('errors.auth.read_only')}</p>}

      <nav className="grid grid-cols-2 gap-3" aria-label={t('nav.menu')}>
        {tiles.map((x) => (
          <Link key={x.to} to={x.to} className="flex min-w-0 items-center gap-3 rounded-[18px] border border-border bg-card p-3.5 text-foreground">
            <Chip tone={x.tone} d={x.d} size={40} iconSize={22} />
            <span className="min-w-0 break-words text-sm font-semibold leading-snug">{x.label}</span>
          </Link>
        ))}
      </nav>

      {privileged && (
        <Link to="/totp" className={CARD + ' block'}>
          <span className="font-medium">{t('totp.title')}</span>
          <span className={`block text-sm ${stepUpActive ? 'text-ok' : 'text-warn'}`}>
            {me?.totp_enabled ? (stepUpActive ? t('totp.active') : t('totp.needed')) : t('totp.notEnrolled')}
          </span>
        </Link>
      )}

      <MyStatements />

      <div className={CARD}>
        <h2 className="mb-2 text-base font-bold">{t('menu.devices')}</h2>
        <ul className="space-y-1">
          {devices.data?.items.map((d) => (
            <li key={d.id} className="flex justify-between text-sm">
              <span>{d.label ?? d.platform}</span>
              {d.current && <span className="text-ok">{t('menu.thisDevice')}</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className={CARD}>
        <h2 className="mb-1 text-base font-bold">{t('menu.securityFeed')}</h2>
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

      </div>
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
    <div className={CARD}>
      <h2 className="mb-1 text-base font-bold">{t('menuReports.title')}</h2>
      <p className="mb-3 text-sm text-muted">{t('menuReports.hint')}</p>
      <label className="block text-sm text-muted">
        {t('menuReports.year')}
        <input type="number" className="field mt-1 w-28" value={year} onChange={(e) => setYear(e.target.value)} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void get(`/reports/statement?period=${year}`, `statement-${year}.pdf`)} className="h-11 rounded-xl bg-primary px-4 font-medium text-primary-foreground">{t('menuReports.statement')}</button>
        <button type="button" onClick={() => void get('/reports/zakat-statement', 'zakat-statement.pdf')} className="h-11 rounded-xl border border-border px-4">{t('menuReports.zakat')}</button>
      </div>
      {error != null && <div className="mt-3"><LoadError error={error} /></div>}
    </div>
  );
}
