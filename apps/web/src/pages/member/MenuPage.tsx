import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Icon, PageHeader } from '../../components/ui';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadFile } from '../../lib/download';
import { localDigits } from '../../lib/format';
import { fmtInstant } from '../../lib/dates';
import { PrivacyToggle } from '../../components/PrivacyToggle';
import { ThemeToggle } from '../../components/ThemeToggle';
import { PushCard } from '../../components/PushCard';
import { Avatar, PhotoSheet, useMyPhoto } from '../../components/MemberPhoto';

/** The fund's first year; the chips run from here to next year. */
const FIRST_YEAR = 2026;
const CARD = 'overflow-clip rounded-[20px] border border-border bg-card p-4';

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
  const myPhoto = useMyPhoto();
  const [photoOpen, setPhotoOpen] = useState(false);

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
          <button type="button" onClick={() => setPhotoOpen(true)} aria-label={t('photo.edit')} className="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar fileId={myPhoto} fallback={me.full_name.trim().charAt(0)} className="h-[50px] w-[50px] bg-primary text-xl font-bold text-primary-foreground" />
            <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-card bg-foreground text-background">
              <Icon d="M4 8h3l2-3h6l2 3h3v11H4z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7" size={11} sw={2.2} />
            </span>
          </button>
          <div className="min-w-[6rem] flex-1">
            <p className="truncate text-[1.0625rem] font-bold">{me.full_name}</p>
            <p className="text-[0.8125rem] text-muted">
              {me.member_code} · {me.roles.map((r) => t(`roles.${r}`)).join(', ')}
            </p>
          </div>
          <PrivacyToggle />
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
      {me && <PhotoSheet open={photoOpen} onClose={() => setPhotoOpen(false)} memberId={me.member_id} name={me.full_name} fileId={myPhoto} />}
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

      <PushCard />

      <MyStatements />

      <div className={CARD}>
        <h2 className="card-head mb-3 pb-3 text-base font-bold">{t('menu.devices')}</h2>
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
        <div className="card-head mb-3 pb-3">
          <h2 className="text-base font-bold">{t('menu.securityFeed')}</h2>
          <p className="text-sm text-muted">{t('menu.securityFeedHint')}</p>
        </div>
        <ul className="space-y-1 text-sm">
          {events.data?.items.slice(0, 20).map((e) => (
            <li key={e.id}>
              <span className="font-medium">{e.member_code}</span> · {t(`menu.deviceEvent.${e.kind}`)} ·{' '}
              <time dateTime={e.at} className="text-muted">
                {fmtInstant(e.at)}
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
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear + 1 - FIRST_YEAR + 1 }, (_, i) => String(FIRST_YEAR + i));
  const [year, setYear] = useState(String(thisYear));
  const withData = useQuery({ queryKey: ['statement-years'], queryFn: () => api<{ years: string[] }>('/reports/statement-years') });
  const noData = withData.data != null && !withData.data.years.includes(year);
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
      <div className="card-head mb-4 pb-3">
        <h2 className="text-base font-bold">{t('menuReports.title')}</h2>
        <p className="text-sm text-muted">{t('menuReports.hint')}</p>
      </div>
      <div role="radiogroup" aria-label={t('menuReports.year')} className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">{t('menuReports.year')}</span>
        {years.map((y) => (
          <button
            key={y}
            type="button"
            role="radio"
            aria-checked={y === year}
            onClick={() => setYear(y)}
            className={`h-9 rounded-full border px-4 text-sm font-semibold transition-colors ${y === year ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-soft text-ink2 hover:bg-hover'}`}
          >
            {localDigits(y)}
          </button>
        ))}
      </div>
      {noData && <p className="-mt-2 mb-3 text-sm text-muted">{t('menuReports.noData', { year: localDigits(year) })}</p>}
      <div className="grid gap-2">
        <button type="button" disabled={noData} onClick={() => void get(`/reports/statement?period=${year}`, `statement-${year}.pdf`)} className="flex min-h-14 items-center justify-between rounded-2xl bg-primary px-4 text-left font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
          <span>{t('menuReports.statement')}<span className="block text-xs font-normal">{t('menuReports.statementFor', { year: localDigits(year) })}</span></span>
          <Icon d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" size={20} />
        </button>
        <button type="button" onClick={() => void get('/reports/zakat-statement', 'zakat-statement.pdf')} className="flex min-h-14 items-center justify-between rounded-2xl border border-border px-4 text-left font-semibold">
          <span>{t('menuReports.zakat')}<span className="block text-xs font-normal text-muted">{t('menuReports.zakatNote')}</span></span>
          <Icon d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" size={20} />
        </button>
      </div>
      {error != null && <div className="mt-3"><LoadError error={error} /></div>}
    </div>
  );
}
