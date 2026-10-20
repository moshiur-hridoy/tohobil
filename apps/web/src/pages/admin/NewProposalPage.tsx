// Static design implementation; Phase 3 will wire the proposals API.
import { useState, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';

const CHECK_ICON = 'M5 12l5 5 9-10';
const LOCK_ICON = 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3';
const GOLD_ICON = 'M7 8h10l4 9H3z M10 8l-1.5 9 M14 8l1.5 9';
const FILE_ICON = 'M6 3h8l4 4v14H6z M14 3v4h4 M12 11v5 M9.5 13.5h5';
const ARROW_LEFT_ICON = 'M15 5l-7 7 7 7';

const PROPOSAL_TYPES = [
  { value: 'investment_purchase', label: 'proposals.type.investmentPurchase' },
  { value: 'expense', label: 'proposals.type.expense' },
  { value: 'rule_change', label: 'proposals.type.ruleChange' },
  { value: 'fine_waiver', label: 'proposals.type.fineWaiver' },
  { value: 'donation', label: 'proposals.type.donation' },
] as const;

const SOURCE_ACCOUNTS = [
  { value: 'bank', label: 'proposals.account.bank' },
  { value: 'cash', label: 'proposals.account.cash' },
  { value: 'charity', label: 'proposals.account.charity' },
] as const;

const MEMBERS = ['জামাল উদ্দিন', 'রহিমা বেগম', 'আবদুল কাদের'] as const;

const VOTE_CONDITIONS = [
  'proposals.condition.interestFree',
  'proposals.condition.notFDR',
  'proposals.condition.notInsurance',
  'proposals.condition.notSpeculation',
  'proposals.condition.legalBusiness',
  'proposals.condition.cashableWithinTerm',
  'proposals.condition.noFixedProfit',
] as const;

export function NewProposalPage() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<string>('investment_purchase');
  const [title, setTitle] = useState<string>('');
  const [maxAmount, setMaxAmount] = useState<string>('');
  const [account, setAccount] = useState<string>('bank');
  const [purpose, setPurpose] = useState<string>('');
  const [subjectMember, setSubjectMember] = useState<string>('');
  const [deadline, setDeadline] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');

  const amountPaisa = useMemo(() => {
    const cleaned = maxAmount.replace(/[^\d]/g, '');
    return cleaned ? BigInt(cleaned) * 100n : 0n;
  }, [maxAmount]);

  const requiresFeasibility = amountPaisa > 10000000n; // > ৳১,০০,০০০
  const canStartVote = !requiresFeasibility || fileName !== '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // eslint-disable-next-line no-console
    console.log('Proposal draft:', {
      type,
      title,
      maxAmountPaisa: amountPaisa.toString(),
      account,
      purpose,
      subjectMember,
      deadline,
      feasibilityFile: fileName || null,
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setFileName(file ? file.name : '');
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        <Link to="/admin/proposals" className="flex items-center gap-1.5 text-foreground hover:text-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ARROW_LEFT_ICON} />
          </svg>
          {t('proposals.title')}
        </Link>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(300px,2fr)]">
        <form onSubmit={handleSubmit} className="rounded-[20px] border border-border bg-card p-6 shadow-sm">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-[13px] bg-warn-bg text-warn">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={GOLD_ICON} />
              </svg>
            </span>
            <div>
              <div className="text-2xl font-bold">{t('proposals.newProposal')}</div>
              <div className="text-sm text-muted">{t('proposals.type.investmentPurchase')}</div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label htmlFor="proposal-type" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.type')}
              </label>
              <select
                id="proposal-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-12 w-full rounded-xl border border-border bg-soft px-4 text-base outline-none focus:ring-2 focus:ring-ring"
              >
                {PROPOSAL_TYPES.map((pt) => (
                  <option key={pt.value} value={pt.value}>
                    {t(pt.label)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="proposal-title" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.title')}
              </label>
              <input
                id="proposal-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('proposals.form.titlePlaceholder')}
                className="h-12 w-full rounded-xl border border-border bg-soft px-4 text-base outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label htmlFor="subject-member" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.subjectMember')}
              </label>
              <select
                id="subject-member"
                value={subjectMember}
                onChange={(e) => setSubjectMember(e.target.value)}
                className="h-12 w-full rounded-xl border border-border bg-soft px-4 text-base outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('proposals.form.noMember')}</option>
                {MEMBERS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="max-amount" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.maxAmount')}
              </label>
              <input
                id="max-amount"
                type="text"
                inputMode="numeric"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder={t('proposals.form.maxAmountPlaceholder')}
                className="h-12 w-full rounded-xl border border-border bg-soft px-4 text-base outline-none focus:ring-2 focus:ring-ring"
              />
              {amountPaisa > 0n && <p className="mt-1 text-sm text-muted">{taka(amountPaisa)}</p>}
            </div>

            <div>
              <label htmlFor="source-account" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.sourceAccount')}
              </label>
              <select
                id="source-account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                className="h-12 w-full rounded-xl border border-border bg-soft px-4 text-base outline-none focus:ring-2 focus:ring-ring"
              >
                {SOURCE_ACCOUNTS.map((sa) => (
                  <option key={sa.value} value={sa.value}>
                    {t(sa.label)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="purpose" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.purpose')}
              </label>
              <textarea
                id="purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                rows={3}
                placeholder={t('proposals.form.purposePlaceholder')}
                className="w-full rounded-xl border border-border bg-soft px-4 py-3 text-base outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label htmlFor="feasibility-file" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.feasibilityFile')}
              </label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-12 w-full items-center gap-2 rounded-xl border border-dashed border-border bg-soft px-4 text-left text-base text-muted hover:bg-hover"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3h8l4 4v14H6z" />
                  <path d="M14 3v4h4" />
                  <path d="M12 11v5" />
                  <path d="M9.5 13.5h5" />
                </svg>
                {fileName || t('proposals.form.chooseFile')}
              </button>
              <input ref={fileInputRef} id="feasibility-file" type="file" className="hidden" onChange={handleFileChange} />
            </div>

            <div>
              <label htmlFor="vote-deadline" className="mb-1.5 block text-sm text-muted">
                {t('proposals.form.voteDeadline')}
              </label>
              <input
                id="vote-deadline"
                type="text"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                placeholder={t('proposals.form.voteDeadlinePlaceholder')}
                className="h-12 w-full rounded-xl border border-border bg-soft px-4 text-base outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {requiresFeasibility && !fileName && (
              <div className="flex items-center gap-3 rounded-xl border-[1.5px] border-dashed border-bad bg-bad-bg p-4 text-sm font-semibold text-bad">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={FILE_ICON} />
                </svg>
                {t('proposals.form.feasibilityRequired')}
              </div>
            )}

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="submit"
                className="flex h-12 items-center gap-2 rounded-[14px] bg-primary px-5 text-[15px] font-bold text-primary-foreground"
              >
                {t('proposals.form.saveDraft')}
              </button>
              <Link
                to="/admin/proposals"
                className="flex h-12 items-center rounded-[14px] border border-border bg-card px-5 text-[15px] font-bold text-foreground hover:bg-hover"
              >
                {t('common.cancel')}
              </Link>
            </div>
          </div>
        </form>

        <section className="rounded-[20px] border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-[13px] bg-primary-soft text-primary">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 4h16v16H4z M9 12l2 2 4-4" />
              </svg>
            </span>
            <div className="text-2xl font-bold">{t('proposals.voteRules.title')}</div>
          </div>
          <div className="mt-3">
            <span className="rounded-full bg-soft px-3 py-1 text-xs font-semibold text-foreground">
              {t('proposals.voteRules.basis')}
            </span>
          </div>
          <div className="mt-4 flex justify-between gap-3 border-t border-border py-3 text-[15px]">
            <span>{t('proposals.voteRules.totalShares')}</span>
            <span>{formatCount(20)}</span>
          </div>
          <div className="flex justify-between gap-3 border-t border-border py-3 text-[15px] font-bold">
            <span>{t('proposals.voteRules.requiredYes')}</span>
            <span>{formatCount(11)}</span>
          </div>
          <div className="border-t border-border pt-4 text-[15px] font-bold">{t('proposals.voteRules.conditions')}</div>
          <div className="mt-1 space-y-1">
            {VOTE_CONDITIONS.map((c, i) => (
              <div key={i} className="flex items-center gap-3 py-2 text-sm">
                <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-ok-bg text-ok">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={CHECK_ICON} />
                  </svg>
                </span>
                {t(c)}
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={!canStartVote}
            className={`mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-[14px] text-[15px] font-bold ${
              canStartVote ? 'bg-primary text-primary-foreground' : 'cursor-not-allowed bg-soft text-muted'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={LOCK_ICON} />
            </svg>
            {t('proposals.voteRules.startVote')}
          </button>
          <p className="mt-2 text-center text-sm text-muted">{t('proposals.voteRules.cannotStart')}</p>
        </section>
      </div>
    </div>
  );
}

export default NewProposalPage;
