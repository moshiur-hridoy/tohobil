// Static design implementation; backend status endpoint pending.
import { useTranslation } from 'react-i18next';
import { formatCount, localDigits } from '../../lib/format';
import { taka } from '../../lib/money';

type HealthCard = {
  labelKey: string;
  valueKey: string;
  subKey: string;
  valueParams?: Record<string, string | number>;
  iconPath: string;
  bg: string;
  fg: string;
};

type AuditLogRow = {
  time: string;
  initial: string;
  who: string;
  whatKey: string;
  whatParams?: Record<string, string | number>;
  device: string;
};

const HEALTH_DATA: HealthCard[] = [
  {
    labelKey: 'systemStatus.health.backup',
    valueKey: 'systemStatus.value.ok',
    subKey: 'systemStatus.sub.backup',
    iconPath: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3 M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
    bg: 'bg-ok-bg',
    fg: 'text-ok',
  },
  {
    labelKey: 'systemStatus.health.restore',
    valueKey: 'systemStatus.value.ok',
    subKey: 'systemStatus.sub.restore',
    iconPath: 'M20 11a8 8 0 1 0-2 5.5 M20 5v6h-6',
    bg: 'bg-ok-bg',
    fg: 'text-ok',
  },
  {
    labelKey: 'systemStatus.health.ledger',
    valueKey: 'systemStatus.value.good',
    subKey: 'systemStatus.sub.ledger',
    iconPath: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
    bg: 'bg-ok-bg',
    fg: 'text-ok',
  },
  {
    labelKey: 'systemStatus.health.offlineCopy',
    valueKey: 'systemStatus.value.daysAgo',
    subKey: 'systemStatus.sub.offlineCopy',
    valueParams: { days: formatCount(33) },
    iconPath: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
    bg: 'bg-warn-bg',
    fg: 'text-warn',
  },
];

const AVATAR_COLORS: Record<string, { bg: string; fg: string }> = {
  আ: { bg: 'bg-primary-soft', fg: 'text-primary' },
  ন: { bg: 'bg-blue-bg', fg: 'text-[#2D5BC4]' },
  ত: { bg: 'bg-[#EDE8F8]', fg: 'text-[#6B4FB3]' },
  মি: { bg: 'bg-warn-bg', fg: 'text-warn' },
};

const AUDIT_LOG_DATA: AuditLogRow[] = [
  {
    time: '১৮ জানু · ১০:১২',
    initial: 'আ',
    who: 'আরিফ হোসেন (ক্যাশিয়ার)',
    whatKey: 'systemStatus.log.paymentReceived',
    whatParams: { member: 'রুমানা খাতুন', amount: taka(2000000n) },
    device: 'Android',
  },
  {
    time: '১৮ জানু · ০৯:৪৫',
    initial: 'ন',
    who: 'নাজমা আক্তার',
    whatKey: 'systemStatus.log.voteViewed',
    device: 'Android',
  },
  {
    time: '১৭ জানু · ২২:০৫',
    initial: 'ত',
    who: 'তানিয়া ইসলাম',
    whatKey: 'systemStatus.log.paymentDeposit',
    whatParams: { amount: taka(500000n), channel: 'বিকাশ' },
    device: 'Web (PWA)',
  },
  {
    time: '১৭ জানু · ১১:৩০',
    initial: 'মি',
    who: 'মিতা বেগম (অডিটর)',
    whatKey: 'systemStatus.log.reconciliationViewed',
    device: 'Web',
  },
  {
    time: '১৬ জানু · ১৫:০২',
    initial: 'আ',
    who: 'আরিফ হোসেন (ক্যাশিয়ার)',
    whatKey: 'systemStatus.log.proposalOpened',
    device: 'Web',
  },
];

function HealthIcon({ path, bg, fg }: { path: string; bg: string; fg: string }) {
  return (
    <span className={`grid h-9 w-9 flex-none place-items-center rounded-[10px] ${bg}`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={fg}>
        <path d={path} />
      </svg>
    </span>
  );
}

export function AdminSystemStatusPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('systemStatus.title')}</h1>
          <p className="mt-2 text-sm text-muted">{t('systemStatus.subtitle')}</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground shadow-sm">
          <span className="h-2 w-2 rounded-full bg-ok" />
          {t('systemStatus.allServicesUp')}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {HEALTH_DATA.map((h) => (
          <div key={h.labelKey} className="rounded-[18px] border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2.5">
              <HealthIcon path={h.iconPath} bg={h.bg} fg={h.fg} />
              <span className="text-sm text-foreground">{t(h.labelKey)}</span>
            </div>
            <div className={`mt-3 text-[22px] font-bold ${h.fg}`}>{h.valueParams ? t(h.valueKey, h.valueParams) : t(h.valueKey)}</div>
            <div className="mt-1 text-xs text-muted">{t(h.subKey)}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3.5 text-sm">
          <span className="text-foreground">{t('systemStatus.jobQueue')}</span>
          <b>{formatCount(0)}</b>
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3.5 text-sm">
          <span className="text-foreground">{t('systemStatus.diskFree')}</span>
          <b>{localDigits('42')} GB</b>
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3.5 text-sm">
          <span className="text-foreground">{t('systemStatus.memory')}</span>
          <b>{localDigits('520')} MB</b>
        </div>
      </div>

      <section className="overflow-x-auto rounded-[20px] border border-border bg-card px-6 py-3 shadow-sm">
        <div className="flex min-h-[60px] items-center justify-between">
          <h2 className="text-[17px] font-bold">{t('systemStatus.auditLog')}</h2>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
            onClick={() => {
              // Export action is pending; implementers should call the audit-log CSV endpoint.
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4v11" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
            {t('systemStatus.exportCsv')}
          </button>
        </div>
        <div className="min-w-[680px]">
          <div className="grid grid-cols-[150px_minmax(0,1.2fr)_minmax(0,1.6fr)_110px] items-center gap-3 border-b border-border py-2 text-xs font-semibold text-muted">
            <span>{t('systemStatus.time')}</span>
            <span>{t('systemStatus.who')}</span>
            <span>{t('systemStatus.what')}</span>
            <span>{t('systemStatus.device')}</span>
          </div>
          {AUDIT_LOG_DATA.map((row) => {
            const color = AVATAR_COLORS[row.initial] ?? { bg: 'bg-soft', fg: 'text-foreground' };
            return (
              <div key={`${row.time}-${row.who}`} className="grid grid-cols-[150px_minmax(0,1.2fr)_minmax(0,1.6fr)_110px] items-center gap-3 border-b border-border py-3.5 text-sm last:border-b-0">
                <span className="text-foreground">{localDigits(row.time)}</span>
                <span className="flex items-center gap-2.5">
                  <span className={`grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-bold ${color.bg} ${color.fg}`}>{row.initial}</span>
                  <span className="truncate">{row.who}</span>
                </span>
                <span className="text-foreground">{row.whatParams ? t(row.whatKey, row.whatParams) : t(row.whatKey)}</span>
                <span className="text-muted">{row.device}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
