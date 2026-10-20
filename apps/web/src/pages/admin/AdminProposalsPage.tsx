// Static design implementation; Phase 3 will wire the proposals API.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';

type ProposalStatus = 'open' | 'approved' | 'draft' | 'implemented';

interface ProposalRow {
  id: string;
  title: string;
  sub: string;
  basis: string;
  result: string;
  status: ProposalStatus;
  statusLabel: string;
  iconPath: string;
  iconBg: string;
  iconFg: string;
  pillBg: string;
  pillFg: string;
}

interface StatItem {
  label: string;
  value: string;
  iconPath: string;
  bg: string;
  fg: string;
}

const VOTE_ICON = 'M4 4h16v16H4z M9 12l2 2 4-4';
const CHECK_ICON = 'M5 12l5 5 9-10';
const DRAFT_ICON = 'M6 3h8l4 4v14H6z M14 3v4h4';
const GOLD_ICON = 'M7 8h10l4 9H3z M10 8l-1.5 9 M14 8l1.5 9';
const BUILDING_ICON = 'M4 21V5l8-2v18 M12 9h8v12 M4 21h16 M7 9h2 M7 13h2 M7 17h2 M15 13h2 M15 17h2';
const WARN_ICON = 'M12 3l10 18H2z M12 10v5 M12 18h.01';
const HEART_ICON = 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z';
const SHIELD_ICON = 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4';

const STATIC_STATS: StatItem[] = [
  { label: 'proposals.stats.open', value: 'proposals.stats.openValue', iconPath: VOTE_ICON, bg: 'bg-primary-soft', fg: 'text-primary' },
  { label: 'proposals.stats.approved', value: 'proposals.stats.approvedValue', iconPath: CHECK_ICON, bg: 'bg-ok-bg', fg: 'text-ok' },
  { label: 'proposals.stats.draft', value: 'proposals.stats.draftValue', iconPath: DRAFT_ICON, bg: 'bg-warn-bg', fg: 'text-warn' },
  { label: 'proposals.stats.implemented', value: 'proposals.stats.implementedValue', iconPath: CHECK_ICON, bg: 'bg-blue-bg', fg: 'text-[#2D5BC4]' },
];

const STATIC_ROWS: ProposalRow[] = [
  {
    id: 'prop-1',
    title: 'proposals.row.goldPurchase',
    sub: 'proposals.row.goldPurchaseSub',
    basis: 'proposals.basis.share',
    result: 'proposals.result.goldPurchase',
    status: 'open',
    statusLabel: 'proposals.status.open',
    iconPath: GOLD_ICON,
    iconBg: 'bg-warn-bg',
    iconFg: 'text-warn',
    pillBg: 'bg-primary-soft',
    pillFg: 'text-primary',
  },
  {
    id: 'prop-2',
    title: 'proposals.row.flatValuation',
    sub: 'proposals.row.flatValuationSub',
    basis: 'proposals.basis.share',
    result: 'proposals.result.flatValuation',
    status: 'approved',
    statusLabel: 'proposals.status.approved',
    iconPath: BUILDING_ICON,
    iconBg: 'bg-blue-bg',
    iconFg: 'text-[#2D5BC4]',
    pillBg: 'bg-ok-bg',
    pillFg: 'text-ok',
  },
  {
    id: 'prop-3',
    title: 'proposals.row.fineWaiver',
    sub: 'proposals.row.fineWaiverSub',
    basis: 'proposals.basis.member',
    result: 'proposals.result.none',
    status: 'draft',
    statusLabel: 'proposals.status.draft',
    iconPath: WARN_ICON,
    iconBg: 'bg-bad-bg',
    iconFg: 'text-bad',
    pillBg: 'bg-soft',
    pillFg: 'text-muted',
  },
  {
    id: 'prop-4',
    title: 'proposals.row.charityDonation',
    sub: 'proposals.row.charityDonationSub',
    basis: 'proposals.basis.member',
    result: 'proposals.result.charityDonation',
    status: 'implemented',
    statusLabel: 'proposals.status.implemented',
    iconPath: HEART_ICON,
    iconBg: 'bg-[#EDE8F8]',
    iconFg: 'text-[#6B4FB3]',
    pillBg: 'bg-soft',
    pillFg: 'text-foreground',
  },
];

const STATIC_CHECKS = [
  'proposals.check.passed',
  'proposals.check.withinDeadline',
  'proposals.check.assetInfoValid',
  'proposals.check.notPreviouslyImplemented',
];

function localizeSub(t: (key: string, options?: Record<string, unknown>) => string, key: string): string {
  if (key === 'proposals.row.goldPurchaseSub') {
    return `${t('proposals.maxAmount')} ${taka(32000000n)} · ${t('proposals.ends')} ${t('proposals.sampleDateShort')}`;
  }
  if (key === 'proposals.row.flatValuationSub') {
    return `${t('proposals.newValue')} ${taka(39000000n)}`;
  }
  if (key === 'proposals.row.fineWaiverSub') {
    return t('proposals.fineToCharityFund');
  }
  if (key === 'proposals.row.charityDonationSub') {
    return `${taka(320000n)} · ${t('proposals.receiptRequired')}`;
  }
  return t(key);
}

function localizeResult(t: (key: string, options?: Record<string, unknown>) => string, key: string): string {
  if (key === 'proposals.result.goldPurchase') {
    return t('proposals.result.patternThree', { yes: formatCount(8), no: formatCount(5), remaining: formatCount(7) });
  }
  if (key === 'proposals.result.flatValuation') {
    return t('proposals.result.patternThree', { yes: formatCount(17), no: formatCount(0), remaining: formatCount(3) });
  }
  if (key === 'proposals.result.charityDonation') {
    return t('proposals.result.patternTwo', { yes: formatCount(8), no: formatCount(0) });
  }
  return t(key);
}

export function AdminProposalsPage() {
  const { t } = useTranslation();
  const [loading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const stats = useMemo(() => STATIC_STATS, []);
  const rows = useMemo(() => STATIC_ROWS, []);
  const checks = useMemo(() => STATIC_CHECKS, []);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('proposals.title')}</h1>
          <p className="mt-2 text-sm text-muted">{t('proposals.subtitle')}</p>
        </div>
        <Link
          to="/admin/proposals/new"
          className="flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-[15px] font-semibold text-primary-foreground"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          {t('proposals.newProposal')}
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="flex items-center gap-3 rounded-[18px] border border-border bg-card p-4 shadow-sm">
            <span className={`grid h-10 w-10 flex-none place-items-center rounded-xl ${s.bg} ${s.fg}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={s.iconPath} />
              </svg>
            </span>
            <div>
              <div className="text-sm text-muted">{t(s.label)}</div>
              <div className="text-[22px] font-bold">{t(s.value)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <section className="min-w-0 flex-[2] rounded-[20px] border border-border bg-card p-2 shadow-sm lg:p-4">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_104px] items-center gap-3 border-b border-border px-4 py-3 text-xs font-semibold text-muted">
            <span>{t('proposals.table.proposal')}</span>
            <span>{t('proposals.table.basis')}</span>
            <span>{t('proposals.table.result')}</span>
            <span>{t('common.status')}</span>
          </div>
          {loading ? (
            <ListSkeleton rows={4} />
          ) : (
            rows.map((r) => {
              const isSelected = selected?.id === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_104px] items-center gap-3 border-b border-border px-4 py-4 text-left text-[15px] last:border-b-0 ${
                    isSelected ? 'bg-primary-soft' : 'hover:bg-hover'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className={`grid h-9 w-9 flex-none place-items-center rounded-[10px] ${r.iconBg} ${r.iconFg}`}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={r.iconPath} />
                      </svg>
                    </span>
                    <span className="min-w-0 font-semibold">
                      {t(r.title)}
                      <span className="block truncate text-xs font-normal text-muted">{localizeSub(t, r.sub)}</span>
                    </span>
                  </span>
                  <span className="text-sm">{t(r.basis)}</span>
                  <span className="text-sm">{localizeResult(t, r.result)}</span>
                  <span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${r.pillBg} ${r.pillFg}`}>{t(r.statusLabel)}</span>
                  </span>
                </button>
              );
            })
          )}
        </section>

        <aside className="min-w-0 flex-1 rounded-[20px] border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-primary-soft text-primary">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={SHIELD_ICON} />
              </svg>
            </span>
            <div>
              <div className="text-lg font-bold">{t('proposals.checklist.title')}</div>
              <div className="text-xs text-muted">{t('proposals.checklist.subtitle')}</div>
            </div>
          </div>
          <div className="mt-3 space-y-1">
            {checks.map((c, i) => (
              <div key={i} className="flex items-center gap-3 border-t border-border py-3 text-sm">
                <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-ok-bg text-ok">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={CHECK_ICON} />
                  </svg>
                </span>
                <span>{t(c)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-xl bg-soft p-3 text-sm leading-relaxed text-foreground">
            {t('proposals.checklist.result')}
          </div>
          <button
            type="button"
            className="mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-[14px] bg-primary text-base font-bold text-primary-foreground"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 11h12v9H6z" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            {t('proposals.checklist.implementTOTP')}
          </button>
        </aside>
      </div>

      {selected && (
        <div className="flex justify-end">
          <Link to={`/admin/proposals/${selected.id}`} className="text-sm font-semibold text-primary">
            {t('common.details')} ›
          </Link>
        </div>
      )}
    </div>
  );
}

export default AdminProposalsPage;
