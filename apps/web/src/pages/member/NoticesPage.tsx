// Static design implementation; backend pending.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type NoticeKind = 'final_notice' | 'fine' | 'payment_received' | 'meeting' | 'zakat_info';

interface Notice {
  id: string;
  kind: NoticeKind;
  titleKey: string;
  bodyKey: string;
  tagKey: string;
  unread: boolean;
  hasAction?: boolean;
  actionKey?: string;
}

const NOTICES: Notice[] = [
  {
    id: 'n1',
    kind: 'final_notice',
    tagKey: 'notices.tags.finalNotice',
    titleKey: 'notices.finalNotice.title',
    bodyKey: 'notices.finalNotice.body',
    unread: true,
    hasAction: true,
    actionKey: 'notices.finalNotice.action',
  },
  {
    id: 'n2',
    kind: 'fine',
    tagKey: 'notices.tags.fine',
    titleKey: 'notices.fine.title',
    bodyKey: 'notices.fine.body',
    unread: true,
  },
  {
    id: 'n3',
    kind: 'payment_received',
    tagKey: 'notices.tags.paymentReceived',
    titleKey: 'notices.paymentReceived.title',
    bodyKey: 'notices.paymentReceived.body',
    unread: false,
  },
  {
    id: 'n4',
    kind: 'meeting',
    tagKey: 'notices.tags.meeting',
    titleKey: 'notices.meeting.title',
    bodyKey: 'notices.meeting.body',
    unread: false,
  },
  {
    id: 'n5',
    kind: 'zakat_info',
    tagKey: 'notices.tags.zakatInfo',
    titleKey: 'notices.zakatInfo.title',
    bodyKey: 'notices.zakatInfo.body',
    unread: false,
  },
];

function kindMeta(kind: NoticeKind): { icon: JSX.Element; borderClass: string; chipClass: string } {
  switch (kind) {
    case 'final_notice':
      return {
        borderClass: 'border-[#F0C6C2]',
        chipClass: 'bg-bad-bg text-bad',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l10 18H2z" />
            <path d="M12 10v5" />
            <path d="M12 18h.01" />
          </svg>
        ),
      };
    case 'fine':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-warn-bg text-warn',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M3 10h18" />
          </svg>
        ),
      };
    case 'payment_received':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-ok-bg text-ok',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" />
            <path d="M8 12l3 3 5-5" />
          </svg>
        ),
      };
    case 'meeting':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-blue-bg text-[#2D5BC4]',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6h16v14H4z" />
            <path d="M4 10h16" />
            <path d="M9 3v4" />
            <path d="M15 3v4" />
          </svg>
        ),
      };
    case 'zakat_info':
      return {
        borderClass: 'border-border',
        chipClass: 'bg-soft text-foreground',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v4h4" />
            <path d="M9 13h6" />
            <path d="M9 17h6" />
          </svg>
        ),
      };
  }
}

export function NoticesPage() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');

  const unreadCount = useMemo(() => NOTICES.filter((n) => n.unread).length, []);
  const visible = useMemo(() => (filter === 'unread' ? NOTICES.filter((n) => n.unread) : NOTICES), [filter]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/home"
          aria-label={t('common.back', { defaultValue: 'ফিরে যান' })}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="flex-1 pl-1">
          <div className="text-[19px] font-bold leading-tight">{t('notices.title', { defaultValue: 'নোটিস' })}</div>
          <div className="text-[13px] text-muted">{t('notices.subtitle', { defaultValue: 'সব বার্তা এখানে থাকে' })}</div>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {/* Unread / All segments */}
        <div className="flex rounded-2xl border border-border bg-card p-1" role="tablist" aria-label={t('notices.filterLabel', { defaultValue: 'নোটিস ফিল্টার' })}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'unread'}
            onClick={() => setFilter('unread')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2 text-sm font-bold transition-colors ${
              filter === 'unread' ? 'bg-primary-soft text-primary' : 'text-muted'
            }`}
          >
            {t('notices.unreadTab', { defaultValue: 'অপঠিত' })}
            {unreadCount > 0 && (
              <span className="grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-bad px-1.5 text-[11px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            onClick={() => setFilter('all')}
            className={`flex-1 rounded-xl py-2 text-sm font-bold transition-colors ${
              filter === 'all' ? 'bg-primary-soft text-primary' : 'text-muted'
            }`}
          >
            {t('notices.allTab', { defaultValue: 'সব' })}
          </button>
        </div>

        {visible.length === 0 ? (
          <p className="py-8 text-center text-muted">{t('common.noData', { defaultValue: 'কোনো তথ্য নেই' })}</p>
        ) : (
          visible.map((notice) => <NoticeCard key={notice.id} notice={notice} />)
        )}
      </main>
    </div>
  );
}

function getTagDefault(kind: NoticeKind): { defaultValue: string } {
  switch (kind) {
    case 'final_notice':
      return { defaultValue: 'চূড়ান্ত নোটিশ · ধারা ২.৪' };
    case 'fine':
      return { defaultValue: 'ফাইন' };
    case 'payment_received':
      return { defaultValue: 'পেমেন্ট গৃহীত' };
    case 'meeting':
      return { defaultValue: 'মিটিং' };
    case 'zakat_info':
      return { defaultValue: 'যাকাত তথ্য' };
  }
}

function getTitleDefault(kind: NoticeKind): { defaultValue: string } {
  switch (kind) {
    case 'final_notice':
      return { defaultValue: 'টানা ৩ মাস বকেয়া: ৳৩৫,০০০' };
    case 'fine':
      return { defaultValue: '৳১,৫০০ ফাইন (৩ শেয়ার × ৳৫০০)' };
    case 'payment_received':
      return { defaultValue: 'আপনার ৳১৫,০০০ গৃহীত হয়েছে' };
    case 'meeting':
      return { defaultValue: '১১ জানুয়ারি, রাত ৯:০০ · অনলাইন' };
    case 'zakat_info':
      return { defaultValue: 'আপনার জমা মূলধনের বিবরণ প্রস্তুত' };
  }
}

function getBodyDefault(kind: NoticeKind): { defaultValue: string } {
  switch (kind) {
    case 'final_notice':
      return { defaultValue: '৫ দিনের মধ্যে পরিশোধ না করলে সদস্যপদ স্থগিত হবে।' };
    case 'fine':
      return { defaultValue: 'এই টাকা দান তহবিলে যাবে, ফান্ডের আয় নয়। মাফের আবেদন করা যায়।' };
    case 'payment_received':
      return { defaultValue: 'কিছু ভুল মনে হলে আপত্তি জানান ›' };
    case 'meeting':
      return { defaultValue: 'টানা ৩টি অনুপস্থিতিতে ৳৫০০ ফাইন (ধারা ৯.২)।' };
    case 'zakat_info':
      return { defaultValue: 'যাকাত আপনি নিজে হিসাব করবেন। PDF দেখুন ›' };
  }
}

function NoticeCard({ notice }: { notice: Notice }) {
  const { t } = useTranslation();
  const meta = kindMeta(notice.kind);

  return (
    <article className={`rounded-[18px] border bg-card p-4 shadow-sm ${meta.borderClass}`}>
      <div className="flex items-center gap-2.5">
        <span className={`grid h-9 w-9 flex-none place-items-center rounded-[11px] ${meta.chipClass}`}>{meta.icon}</span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.chipClass}`}>{t(notice.tagKey, getTagDefault(notice.kind))}</span>
      </div>
      <h2 className="mt-2.5 text-base font-bold">{t(notice.titleKey, getTitleDefault(notice.kind))}</h2>
      <p className="mt-1 text-sm leading-relaxed text-foreground">
        {t(notice.bodyKey, getBodyDefault(notice.kind))}
      </p>
      {notice.hasAction && (
        <button type="button" className="mt-3 h-12 rounded-xl bg-primary px-4 text-[15px] font-bold text-primary-foreground">
          {t(notice.actionKey ?? 'notices.payNow', { defaultValue: 'এখনই পরিশোধ করুন' })}
        </button>
      )}
    </article>
  );
}
