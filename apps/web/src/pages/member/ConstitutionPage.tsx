// Static design implementation; backend pending.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface Clause {
  id: string;
  no: string;
  titleKey: string;
  subKey: string;
  bg: string;
  fg: string;
}

const CLAUSES: Clause[] = [
  {
    id: '1.4',
    no: '১.৪',
    titleKey: 'constitution.clause.1_4.title',
    subKey: 'constitution.clause.1_4.sub',
    bg: 'bg-primary-soft',
    fg: 'text-primary',
  },
  {
    id: '2.2',
    no: '২.২',
    titleKey: 'constitution.clause.2_2.title',
    subKey: 'constitution.clause.2_2.sub',
    bg: 'bg-warn-bg',
    fg: 'text-warn',
  },
  {
    id: '2.4',
    no: '২.৪',
    titleKey: 'constitution.clause.2_4.title',
    subKey: 'constitution.clause.2_4.sub',
    bg: 'bg-bad-bg',
    fg: 'text-bad',
  },
  {
    id: '4.2',
    no: '৪.২',
    titleKey: 'constitution.clause.4_2.title',
    subKey: 'constitution.clause.4_2.sub',
    bg: 'bg-blue-bg',
    fg: 'text-[#2D5BC4]',
  },
  {
    id: '5.1',
    no: '৫.১',
    titleKey: 'constitution.clause.5_1.title',
    subKey: 'constitution.clause.5_1.sub',
    bg: 'bg-[#EDE8F8]',
    fg: 'text-[#6B4FB3]',
  },
];

export function ConstitutionPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return CLAUSES;
    return CLAUSES.filter(
      (c) =>
        t(c.titleKey, { defaultValue: '' }).includes(q) ||
        t(c.subKey, { defaultValue: '' }).includes(q) ||
        c.no.includes(q)
    );
  }, [query, t]);

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
        <div className="flex-1 pl-1 text-[19px] font-bold">{t('constitution.title', { defaultValue: 'নীতিমালা' })}</div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {/* New-version alert */}
        <section className="flex items-center gap-3 rounded-[18px] border border-[#F0DDAE] bg-warn-bg p-3">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-card text-warn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" />
              <path d="M10 20a2 2 0 0 0 4 0" />
            </svg>
          </span>
          <div className="flex-1">
            <div className="text-[15px] font-bold text-warn">{t('constitution.newVersionBanner', { defaultValue: 'নতুন ভার্সন ১.১ কার্যকর' })}</div>
            <div className="text-[13px] text-foreground">{t('constitution.newVersionHint', { defaultValue: 'পড়ে “পড়েছি” চাপুন।' })}</div>
          </div>
          <button
            type="button"
            className="h-11 rounded-xl bg-primary px-4 text-[15px] font-bold text-primary-foreground"
          >
            {t('constitution.read', { defaultValue: 'পড়েছি' })}
          </button>
        </section>

        {/* Current constitution card */}
        <section className="flex items-center gap-3.5 rounded-[20px] border border-border bg-card p-4 shadow-sm">
          <span className="grid h-12 w-12 flex-none place-items-center rounded-[14px] bg-blue-bg text-[#2D5BC4]">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 3h8l4 4v14H6z" />
              <path d="M14 3v4h4" />
              <path d="M9 13h6" />
              <path d="M9 17h6" />
            </svg>
          </span>
          <div className="flex-1">
            <div className="text-[17px] font-bold">{t('constitution.documentTitle', { defaultValue: 'গঠনতন্ত্র (নীতিমালা)' })}</div>
            <div className="text-xs text-muted">{t('constitution.currentVersion', { defaultValue: 'ভার্সন ১.১' })} · {t('constitution.effectiveDate', { defaultValue: 'কার্যকর ১ জানুয়ারি ২০২৭' })}</div>
          </div>
          <a
            href="#"
            className="flex items-center gap-1 text-[13px] font-bold text-primary"
            onClick={(e) => e.preventDefault()}
          >
            {t('constitution.pdf', { defaultValue: 'PDF' })}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 4v11" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
          </a>
        </section>

        {/* Search */}
        <label className="flex h-[52px] items-center gap-2.5 rounded-2xl border-[1.5px] border-border bg-card px-3.5 text-muted">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('constitution.searchPlaceholder', { defaultValue: 'ধারা খুঁজুন' })}
            className="flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted"
          />
        </label>

        {/* Clause list */}
        <section className="rounded-[20px] border border-border bg-card px-4 py-1 shadow-sm">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-muted">{t('common.noData', { defaultValue: 'কোনো তথ্য নেই' })}</p>
          ) : (
            <ul>
              {filtered.map((c) => (
                <li key={c.id} className="flex min-h-[66px] items-center gap-3 border-b border-border last:border-b-0 py-2">
                  <span className={`grid h-11 w-11 flex-none place-items-center rounded-[13px] text-sm font-bold ${c.bg} ${c.fg}`}>{c.no}</span>
                  <div className="flex-1">
                    <div className="text-base font-semibold">{t(c.titleKey, { defaultValue: '' })}</div>
                    <div className="text-[13px] text-muted">{t(c.subKey, { defaultValue: '' })}</div>
                  </div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden="true">
                    <path d="M9 5l7 7-7 7" />
                  </svg>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Older versions link */}
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
          className="flex min-h-11 items-center gap-1.5 text-sm font-bold text-primary"
        >
          {t('constitution.olderVersions', { defaultValue: 'পুরনো ভার্সনগুলো দেখুন' })}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </a>
      </main>
    </div>
  );
}
