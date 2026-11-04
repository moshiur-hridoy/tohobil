import { usesPinStepUp } from '@barakah/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Icon, PageHeader, Switch } from '../../components/ui';
import { LoadError } from '../../components/StateViews';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadFile } from '../../lib/download';
import { APP_VERSION } from '../../lib/changelog';
import { localDigits } from '../../lib/format';
import { setPrivate, usePrivacy } from '../../lib/privacy';
import { currentTheme, setTheme, type Theme } from '../../lib/theme';
import { PushRow } from '../../components/PushRow';
import { Avatar, PhotoSheet, useMyPhoto } from '../../components/MemberPhoto';
import type { DeviceRow } from './DevicesPage';

/** The fund's first year; the chips run from here to next year. */
const FIRST_YEAR = 2026;
const CARD = 'overflow-clip rounded-[20px] border border-border bg-card p-4';
/** A card holding several rows separated by thin lines. */
const GROUP = 'divide-y divide-border overflow-clip rounded-[20px] border border-border bg-card';
const ROW = 'flex min-h-14 items-center gap-3 px-4 py-3';
const CHEVRON = 'M9 6l6 6-6 6';
/** Neutral tile for the icon at the start of a settings row. */
const ROW_ICON = 'bg-soft text-ink2';
const ICONS = {
  eyeOff: 'M3 3l18 18 M10.6 10.6a2 2 0 002.8 2.8 M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 4.5 10 7a13 13 0 01-2.7 3.7 M6.6 6.6C4.3 8 2.8 10.2 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.5 4.8-1.3',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  key: 'M15 7a2 2 0 012 2 M15 3a6 6 0 11-5.2 9L3 18.8V21h3v-2h2v-2h2l1.8-1.8A6 6 0 0115 3z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z M9 12l2 2 4-4',
  phone: 'M7 2h10a1 1 0 011 1v18a1 1 0 01-1 1H7a1 1 0 01-1-1V3a1 1 0 011-1z M11 18h2',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
};

export function MenuPage() {
  const { t } = useTranslation();
  const { me, logout } = useAuth();
  const navigate = useNavigate();

  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<{ items: DeviceRow[] }>('/me/devices') });
  const myPhoto = useMyPhoto();
  const [photoOpen, setPhotoOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const hidden = usePrivacy();
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  const privileged = !!me?.roles.some((r) => r === 'cashier' || r === 'auditor');
  // Only the cashier uses the authenticator; the auditor confirms with their PIN (ASSUMPTIONS.md 117).
  const usesAuthenticator = !!me && privileged && !usesPinStepUp(me.roles);
  const stepUpActive = !!me?.step_up_until;

  const tiles = [
    { to: '/menu/constitution', label: t('menuLinks.constitution'), tone: 'bg-blue-bg text-blue', d: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h11' },
    { to: '/menu/notices', label: t('menuLinks.notices'), tone: 'bg-warn-bg text-warn', d: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7 M10 20a2 2 0 0 0 4 0' },
    { to: '/menu/ledger', label: t('menuLinks.ledger'), tone: 'bg-primary-soft text-primary', d: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 13h6 M9 17h6' },
    { to: '/menu/settlement', label: t('menuLinks.settlement'), tone: 'bg-vio-bg text-vio', d: 'M4 12h12 M12 7l5 5-5 5 M20 5v14' },
    { to: '/menu/members', label: t('menuLinks.members'), tone: 'bg-primary-soft text-primary', d: 'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1 M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M20 20v-1a4 4 0 0 0-3-3.8 M16 4.2a3.5 3.5 0 0 1 0 6.6' },
  ];

  return (
    <div>
      <PageHeader title={t('nav.menu')} />
      <div className="flex flex-col gap-3 px-4 pb-6 pt-1">
      {me && (
        <section className={CARD + ' flex items-center gap-3'}>
          <button type="button" onClick={() => setPhotoOpen(true)} aria-label={t('photo.edit')} className="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar fileId={myPhoto} fallback={me.full_name.trim().charAt(0)} className="h-[50px] w-[50px] bg-primary text-xl font-bold text-primary-foreground" />
            <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-card bg-foreground text-background">
              <Icon d="M4 8h3l2-3h6l2 3h3v11H4z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7" size={11} sw={2.2} />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[1.0625rem] font-bold">{me.full_name}</p>
            <p className="text-[0.8125rem] text-muted">
              {me.member_code} · {me.roles.map((r) => t(`roles.${r}`)).join(', ')}
            </p>
          </div>
        </section>
      )}
      {me && <PhotoSheet open={photoOpen} onClose={() => setPhotoOpen(false)} memberId={me.member_id} name={me.full_name} fileId={myPhoto} />}
      {me?.read_only && <p className="rounded-xl bg-warn-bg p-3 text-sm text-warn">{t('errors.auth.read_only')}</p>}

      {/* Cashier and auditor reach the admin pages from a phone too (the auditor may have no computer). */}
      {privileged && (
        <Link to="/admin" className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-3.5 text-foreground">
          <Chip tone="bg-primary-soft text-primary" size={40} iconSize={22} d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{t('menu.adminPanel')}</span>
            <span className="block text-sm text-muted">{t('menu.adminPanelHint')}</span>
          </span>
          <span className="shrink-0 text-muted">
            <Icon d={CHEVRON} size={18} />
          </span>
        </Link>
      )}

      <nav className="grid grid-cols-2 gap-3" aria-label={t('nav.menu')}>
        {tiles.map((x, i) => (
          <Link
            key={x.to}
            to={x.to}
            className={`flex min-w-0 items-center gap-3 rounded-[18px] border border-border bg-card p-3.5 text-foreground ${i === tiles.length - 1 && tiles.length % 2 === 1 ? 'col-span-2' : ''}`}
          >
            <Chip tone={x.tone} d={x.d} size={40} iconSize={22} />
            <span className="min-w-0 break-words text-sm font-semibold leading-snug">{x.label}</span>
          </Link>
        ))}
      </nav>

      <MyStatements />

      <Section title={t('menu.settings')}>
        <div className={GROUP}>
          <div className={ROW}>
            <Chip tone={ROW_ICON} d={ICONS.eyeOff} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t('privacy.hide')}</p>
              <p className="text-sm text-muted">{t('menu.hideAmountsHint')}</p>
            </div>
            <Switch checked={hidden} onChange={setPrivate} label={t('privacy.hide')} />
          </div>
          <div className={ROW}>
            <Chip tone={ROW_ICON} d={ICONS.moon} />
            <p className="min-w-0 flex-1 font-medium">{t('menu.darkMode')}</p>
            <Switch
              checked={theme === 'dark'}
              onChange={(dark) => {
                const next: Theme = dark ? 'dark' : 'light';
                setTheme(next);
                setThemeState(next);
              }}
              label={t('menu.darkMode')}
            />
          </div>
          <PushRow className="px-4 py-3" />
          <LinkRow to="/menu/pin" icon={ICONS.key} label={t('pinChange.title')} />
          {usesAuthenticator && (
            <LinkRow
              to="/totp"
              icon={ICONS.shield}
              label={t('totp.title')}
              hint={me?.totp_enabled ? (stepUpActive ? t('totp.active') : t('totp.needed')) : t('totp.notEnrolled')}
              hintClass={stepUpActive ? 'text-ok' : 'text-warn'}
            />
          )}
        </div>
      </Section>

      <Section title={t('menu.security')}>
        <div className={GROUP}>
          <LinkRow
            to="/menu/devices"
            icon={ICONS.phone}
            label={t('devices.title')}
            hint={t('menu.devicesHint')}
            value={devices.data ? t('menu.devicesCount', { count: devices.data.items.length }) : undefined}
          />
          <LinkRow to="/menu/security" icon={ICONS.activity} label={t('menu.securityFeed')} hint={t('menu.securityFeedHint')} />
        </div>
      </Section>

      <div className={GROUP + ' mt-3'}>
        <LinkRow to="/menu/whats-new" icon={ICONS.sparkle} label={t('whatsNew.title')} value={t('whatsNew.version', { version: localDigits(APP_VERSION) })} />
      </div>

      <button
        type="button"
        onClick={() => setLogoutOpen(true)}
        className="mt-3 flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-border bg-card font-semibold text-bad"
      >
        <Icon d="M9 4H5v16h4 M16 8l4 4-4 4 M20 12H9" size={18} />
        {t('menu.logout')}
      </button>
      <ConfirmSheet
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        title={t('menu.logoutConfirmTitle')}
        confirmLabel={t('menu.logout')}
        tone="danger"
        onConfirm={async () => {
          await logout();
          void navigate('/login', { replace: true });
        }}
      >
        <p>{t('menu.logoutConfirmBody')}</p>
      </ConfirmSheet>
      </div>
    </div>
  );
}

/** A small muted heading over a group of rows. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3">
      <h2 className="px-1 pb-2 text-sm font-semibold text-muted">{title}</h2>
      {children}
    </section>
  );
}

/** A tappable row: label, optional hint underneath, optional value on the right, and an arrow. */
function LinkRow({ to, icon, label, hint, hintClass = 'text-muted', value }: { to: string; icon?: string; label: string; hint?: string; hintClass?: string; value?: string }) {
  return (
    <Link to={to} className={ROW + ' text-foreground hover:bg-hover'}>
      {icon && <Chip tone={ROW_ICON} d={icon} />}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className={`block text-sm ${hintClass}`}>{hint}</span>}
      </span>
      {value && <span className="shrink-0 text-sm text-muted">{value}</span>}
      <span className="shrink-0 text-muted">
        <Icon d={CHEVRON} size={18} />
      </span>
    </Link>
  );
}

/** One downloadable PDF: a small document tile, the name with a hint, and a download arrow. */
function PdfRow({ label, hint, disabled, onClick }: { label: string; hint: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={ROW + ' w-full text-left text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'}>
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
        <Icon d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5zm0 0v5h5M9 13h6M9 17h4" size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
      <span className="shrink-0 text-muted">
        <Icon d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" size={20} />
      </span>
    </button>
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-muted">{t('menuReports.year')}</span>
        <div role="radiogroup" aria-label={t('menuReports.year')} className="inline-flex rounded-full border border-border bg-soft p-0.5">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              role="radio"
              aria-checked={y === year}
              onClick={() => setYear(y)}
              className={`h-8 rounded-full px-3.5 text-sm font-semibold transition-colors ${y === year ? 'bg-card text-foreground shadow-sm' : 'text-muted hover:text-foreground'}`}
            >
              {localDigits(y)}
            </button>
          ))}
        </div>
      </div>
      {noData && <p className="mb-3 text-sm text-muted">{t('menuReports.noData', { year: localDigits(year) })}</p>}
      <div className="divide-y divide-border overflow-clip rounded-2xl border border-border">
        <PdfRow
          label={t('menuReports.statement')}
          hint={t('menuReports.statementFor', { year: localDigits(year) })}
          disabled={noData}
          onClick={() => void get(`/reports/statement?period=${year}`, `statement-${year}.pdf`)}
        />
        <PdfRow
          label={t('menuReports.zakat')}
          hint={t('menuReports.zakatNote')}
          onClick={() => void get('/reports/zakat-statement', 'zakat-statement.pdf')}
        />
      </div>
      {error != null && <div className="mt-3"><LoadError error={error} /></div>}
    </div>
  );
}
