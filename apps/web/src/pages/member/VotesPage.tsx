import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

// Static design implementation. Phase 3 will wire the proposals API and convert this to a real list + vote action.

type VoteChoice = 'yes' | 'no' | 'abstain' | null;

interface Voter {
  initial: string;
  name: string;
  shares: number;
  vote: VoteChoice;
  isMe?: boolean;
}

const yesCount = 8;
const noCount = 5;
const outstandingShares = 7;
const totalShares = 20;
const thresholdShares = 11;
const remaining = Math.max(0, thresholdShares - yesCount);

const voters: Voter[] = [
  { initial: 'আ', name: 'আরিফ হোসেন', shares: 2, vote: 'yes' },
  { initial: 'সে', name: 'সেলিম রহমান', shares: 4, vote: 'yes' },
  { initial: 'তা', name: 'তানিয়া ইসলাম', shares: 1, vote: 'yes' },
  { initial: 'ফা', name: 'ফারুক আহমেদ', shares: 1, vote: 'no' },
  { initial: 'মি', name: 'মিতা বেগম', shares: 1, vote: 'yes' },
  { initial: 'জা', name: 'জামাল উদ্দিন', shares: 4, vote: 'no' },
  { initial: 'রু', name: 'রুমানা খাতুন', shares: 4, vote: null },
  { initial: 'ন', name: 'আমি', shares: 3, vote: null, isMe: true },
];

const avColors = [
  { bg: 'bg-primary-soft', fg: 'text-primary' },
  { bg: 'bg-blue-bg', fg: 'text-[#2D5BC4]' },
  { bg: 'bg-[#EDE8F8]', fg: 'text-[#6B4FB3]' },
  { bg: 'bg-warn-bg', fg: 'text-warn' },
];

function voteChip(choice: VoteChoice, t: (k: string) => string) {
  switch (choice) {
    case 'yes':
      return { label: t('votes.yes'), bg: 'bg-ok-bg', fg: 'text-ok' };
    case 'no':
      return { label: t('votes.no'), bg: 'bg-bad-bg', fg: 'text-bad' };
    default:
      return { label: t('votes.notYet'), bg: 'bg-soft', fg: 'text-muted' };
  }
}

export function VotesPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/home"
          aria-label={t('common.back')}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
        </Link>
        <div className="flex-1 pl-1 text-[19px] font-bold">{t('votes.title')}</div>
        <span className="rounded-full bg-warn-bg px-3 py-1 text-xs font-bold text-warn">{t('votes.open')}</span>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {/* Proposal detail */}
        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary">{t('votes.investmentPurchase')}</span>
            <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-foreground">{t('votes.shareBased')} · {t('votes.clause')} ৪.২, ১২.২</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-[13px] bg-warn-bg text-warn">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 8h10l4 9H3z" /><path d="M10 8l-1.5 9" /><path d="M14 8l1.5 9" /></svg>
            </span>
            <h1 className="text-[22px] font-bold leading-tight">{t('votes.exampleTitle')}</h1>
          </div>
          <div className="mt-3.5 grid grid-cols-2 gap-2.5">
            <div className="rounded-[14px] bg-background p-3">
              <div className="text-xs text-muted">{t('votes.maxSpend')}</div>
              <div className="mt-0.5 text-[19px] font-bold">{t('votes.exampleMax')}</div>
            </div>
            <div className="rounded-[14px] bg-background p-3">
              <div className="text-xs text-muted">{t('votes.sourceAccount')}</div>
              <div className="mt-0.5 text-[19px] font-bold">{t('votes.exampleSource')}</div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3 rounded-[14px] border border-border p-3">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-blue-bg text-[#2D5BC4]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 13h6" /><path d="M9 17h6" /></svg>
            </span>
            <div className="flex-1 text-[13px] leading-relaxed text-foreground">{t('votes.feasibilityAttached')}</div>
            <span className="text-[13px] font-bold text-primary">{t('common.view')}</span>
          </div>
          <div className="mt-3 flex items-center gap-2.5 text-[13px] font-semibold text-ok">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
            {t('votes.shariaCompliant')}
          </div>
        </section>

        {/* Result */}
        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-primary-soft text-primary">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20v-6" /><path d="M10 20V5" /><path d="M16 20v-9" /><path d="M21 20H3" /></svg>
            </span>
            <div className="flex-1 text-base font-bold">{t('votes.currentResult')}</div>
            <div className="text-[13px] text-muted">{t('votes.totalShares', { count: totalShares })}</div>
          </div>
          <div className="my-3.5 flex h-3.5 overflow-hidden rounded-full bg-soft">
            <div className="bg-ok" style={{ width: `${(yesCount / totalShares) * 100}%` }} />
            <div className="border-l-2 border-card bg-bad" style={{ width: `${(noCount / totalShares) * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-ok" />
              <b>{t('votes.yesCount', { count: yesCount })}</b>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-bad" />
              <b>{t('votes.noCount', { count: noCount })}</b>
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-2.5 w-2.5 rounded-full border border-border bg-soft" />
              {t('votes.remainingCount', { count: outstandingShares })}
            </span>
          </div>
          <div className="mt-2.5 text-[13px] leading-relaxed text-foreground">
            {t('votes.needYesToPass', { threshold: thresholdShares, remaining })}
          </div>
          <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-warn-bg p-3 text-[13px] font-semibold text-warn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 7v5l3 2" /></svg>
            {t('votes.closesIn', { date: t('votes.exampleClose') })}
          </div>
        </section>

        {/* Voter list */}
        <section className="rounded-[20px] border border-border bg-card px-4 py-3.5 shadow-sm">
          <div className="mb-1 text-base font-bold">{t('votes.whoVoted')}</div>
          <ul>
            {voters.map((v, i) => {
              const chip = voteChip(v.vote, t);
              const colors = v.isMe ? { bg: 'bg-primary', fg: 'text-white' } : avColors[i % avColors.length]!;
              return (
                <li key={i} className="flex min-h-[44px] items-center gap-3 border-t border-border first:border-t-0 py-2">
                  <span className={`grid h-[30px] w-[30px] flex-none place-items-center rounded-full text-[13px] font-bold ${colors.bg} ${colors.fg}`}>
                    {v.initial}
                  </span>
                  <span className="flex-1 text-[15px]" style={{ fontWeight: v.isMe ? 700 : 400 }}>
                    {v.name}{' '}
                    <span className="text-xs text-muted">· {v.shares}</span>
                  </span>
                  <span className={`rounded-full px-3 py-0.5 text-xs font-bold ${chip.bg} ${chip.fg}`}>{chip.label}</span>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border py-2 text-xs text-muted">{t('votes.publicHint')}</div>
        </section>
      </main>

      {/* Action buttons */}
      <div className="sticky bottom-0 border-t border-border bg-card p-3">
        <div className="grid grid-cols-3 gap-2.5">
          <button type="button" className="flex h-14 items-center justify-center gap-1.5 rounded-2xl bg-ok font-bold text-white">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
            {t('votes.yes')}
          </button>
          <button type="button" className="flex h-14 items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-bad bg-card font-bold text-bad">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
            {t('votes.no')}
          </button>
          <button type="button" className="flex h-14 items-center justify-center rounded-2xl border border-border bg-card text-base font-semibold text-foreground">
            {t('votes.abstain')}
          </button>
        </div>
      </div>
    </div>
  );
}
