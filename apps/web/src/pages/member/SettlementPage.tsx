// Static design implementation; backend pending.

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { taka } from '../../lib/money';

interface QuoteLine {
  labelKey: string;
  value: string;
  colorClass: string;
  weightClass: string;
}

interface PayoutLine {
  dateKey: string;
  amountPaisa: bigint;
}

const QUOTE_LINES: QuoteLine[] = [
  { labelKey: 'settlement.paidInCapital', value: taka(8_000_000n), colorClass: 'text-foreground', weightClass: 'font-normal' },
  { labelKey: 'settlement.serviceCharge', value: `−${taka(800_000n)}`, colorClass: 'text-bad', weightClass: 'font-normal' },
  { labelKey: 'settlement.unpaidFines', value: `−${taka(200_000n)}`, colorClass: 'text-bad', weightClass: 'font-normal' },
  { labelKey: 'settlement.netRefund', value: taka(7_000_000n), colorClass: 'text-ok', weightClass: 'font-bold' },
];

const PAYOUT_PLAN: PayoutLine[] = [
  { dateKey: 'settlement.dates.feb15', amountPaisa: 3_000_000n },
  { dateKey: 'settlement.dates.mar15', amountPaisa: 2_000_000n },
  { dateKey: 'settlement.dates.apr15', amountPaisa: 2_000_000n },
];

export function SettlementPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/menu"
          aria-label={t('common.back', { defaultValue: 'ফিরে যান' })}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="flex-1 pl-1">
          <div className="text-[19px] font-bold leading-tight">{t('settlement.title', { defaultValue: 'সেটেলমেন্ট প্রস্তাব' })}</div>
          <div className="text-[13px] text-muted">{t('settlement.subtitle', { defaultValue: 'সদস্য প্রস্থান · ধারা ৫.১' })}</div>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {/* Tags */}
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-foreground">{t('settlement.shareBasedTag', { defaultValue: 'সদস্য ভিত্তিক · >৫০%' })}</span>
          <span className="rounded-full bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">{t('settlement.timeRemainingTag', { defaultValue: 'সময় শেষ ২ দিন' })}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-primary-soft px-2.5 py-1 text-xs font-bold text-primary">{t('settlement.earlyExitTag', { defaultValue: 'আগেভাগে প্রস্থান ✓' })}</span>
          <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-foreground">{t('settlement.humanitarianTag', { defaultValue: 'মানবিক' })}</span>
          <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-foreground">{t('settlement.inactiveTag', { defaultValue: 'নিষ্ক্রিয়' })}</span>
          <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-foreground">{t('settlement.deathTag', { defaultValue: 'মৃত্যু' })}</span>
        </div>

        {/* Quote breakdown */}
        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-bad-bg text-sm font-bold text-bad">{t('settlement.memberInitial', { defaultValue: 'জা' })}</span>
            <div className="text-[17px] font-bold">
              {t('settlement.memberNameShares', { name: t('settlement.memberName', { defaultValue: 'জামাল উদ্দিন' }), count: 4, defaultValue: 'জামাল উদ্দিন · ৪ শেয়ার' })}
            </div>
          </div>

          <ul>
            {QUOTE_LINES.map((line, index) => (
              <li
                key={index}
                className={`flex justify-between gap-3 border-t border-border py-2.5 text-[15px] first:border-t-0 ${line.weightClass} ${line.colorClass}`}
              >
                <span>{t(line.labelKey, getQuoteDefault(index))}</span>
                <span>{line.value}</span>
              </li>
            ))}
          </ul>

          <div className="mt-2 flex items-start gap-2 rounded-xl bg-background p-3 text-[13px] leading-relaxed text-foreground">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" />
              <path d="M12 8v.01" />
              <path d="M11 12h1v5h1" />
            </svg>
            {t('settlement.disclaimer', { defaultValue: 'লভ্যাংশ দেওয়া হবে না (ধারা ৫.১)। শেয়ারদরের হিসাব এখানে ব্যবহৃত হয়নি।' })}
          </div>
        </section>

        {/* Payout plan */}
        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-primary-soft text-primary">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6h16v14H4z" />
                <path d="M4 10h16" />
                <path d="M9 3v4" />
                <path d="M15 3v4" />
              </svg>
            </span>
            <div className="text-base font-bold">{t('settlement.payoutPlan', { defaultValue: 'ফেরতের পরিকল্পনা' })}</div>
          </div>

          <ul>
            {PAYOUT_PLAN.map((p, index) => (
              <li key={index} className="flex justify-between gap-3 border-t border-border py-2.5 text-[15px] first:border-t-0">
                <span>{t(p.dateKey, getPayoutDateDefault(index))}</span>
                <span className="font-bold">{taka(p.amountPaisa)}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Validation checklist */}
        <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <ul className="space-y-2">
            <li>
              <span className="inline-flex items-center gap-2 rounded-full bg-ok-bg px-2.5 py-1 text-xs font-bold text-ok">
                {t('settlement.checkReturnWithinCapital', { defaultValue: '✓ ফেরত ≤ জমা মূলধন' })}
              </span>
            </li>
            <li>
              <span className="inline-flex items-center gap-2 rounded-full bg-ok-bg px-2.5 py-1 text-xs font-bold text-ok">
                {t('settlement.checkFeeExactlyTen', { defaultValue: '✓ ফি ঠিক ১০%' })}
              </span>
            </li>
            <li>
              <span className="inline-flex items-center gap-2 rounded-full bg-ok-bg px-2.5 py-1 text-xs font-bold text-ok">
                {t('settlement.checkInstallmentsEqualNet', { defaultValue: '✓ কিস্তির যোগফল = নিট' })}
              </span>
            </li>
          </ul>
        </section>

        {/* Action buttons */}
        <div className="grid grid-cols-3 gap-2.5 pt-2">
          <button type="button" className="flex h-14 items-center justify-center rounded-2xl bg-ok text-[17px] font-bold text-white">
            {t('common.yes', { defaultValue: 'হ্যাঁ' })}
          </button>
          <button type="button" className="flex h-14 items-center justify-center rounded-2xl border-[1.5px] border-bad bg-card text-[17px] font-bold text-bad">
            {t('common.no', { defaultValue: 'না' })}
          </button>
          <button type="button" className="flex h-14 items-center justify-center rounded-2xl border border-border bg-card text-base font-semibold text-foreground">
            {t('votes.abstain', { defaultValue: 'বিরত' })}
          </button>
        </div>
      </main>
    </div>
  );
}

function getQuoteDefault(index: number): { defaultValue: string } {
  switch (index) {
    case 0:
      return { defaultValue: 'জমা মূলধন' };
    case 1:
      return { defaultValue: 'সার্ভিস চার্জ ১০%' };
    case 2:
      return { defaultValue: 'অনাদায়ী ফাইন' };
    default:
      return { defaultValue: 'নিট ফেরত' };
  }
}

function getPayoutDateDefault(index: number): { defaultValue: string } {
  switch (index) {
    case 0:
      return { defaultValue: '১৫ ফেব্রুয়ারি' };
    case 1:
      return { defaultValue: '১৫ মার্চ' };
    default:
      return { defaultValue: '১৫ এপ্রিল' };
  }
}
