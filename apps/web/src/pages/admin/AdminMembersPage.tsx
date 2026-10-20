import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { taka } from '../../lib/money';
import type { MemberRow } from '../../lib/types';

const MEMBER_AVATAR_COLORS = [
  { bg: 'bg-primary-soft', fg: 'text-primary' },
  { bg: 'bg-blue-bg', fg: 'text-[#2D5BC4]' },
  { bg: 'bg-[#EDE8F8]', fg: 'text-[#6B4FB3]' },
  { bg: 'bg-warn-bg', fg: 'text-warn' },
  { bg: 'bg-bad-bg', fg: 'text-bad' },
];

function initial(name: string): string {
  return name.trim().slice(0, 1) || '?';
}

function statusChip(status: string, t: (k: string) => string) {
  switch (status) {
    case 'active':
      return { label: t('member.status.active'), bg: 'bg-ok-bg', fg: 'text-ok' };
    case 'warning':
      return { label: t('member.status.warning'), bg: 'bg-warn-bg', fg: 'text-warn' };
    case 'suspended':
      return { label: t('member.status.suspended'), bg: 'bg-bad-bg', fg: 'text-bad' };
    case 'deceased':
      return { label: t('member.status.deceased'), bg: 'bg-soft', fg: 'text-muted' };
    case 'exited':
      return { label: t('member.status.exited'), bg: 'bg-soft', fg: 'text-muted' };
    default:
      return { label: status, bg: 'bg-soft', fg: 'text-foreground' };
  }
}

export function AdminMembersPage() {
  const { t } = useTranslation();
  const members = useQuery({
    queryKey: ['members', 'admin'],
    queryFn: () => api<{ items: MemberRow[] }>('/members?limit=200'),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const totalShares = (members.data?.items ?? []).reduce((sum, m) => sum + m.shares, 0);
  const selected = members.data?.items.find((m) => m.id === selectedId) ?? members.data?.items[0];

  if (members.error) {
    return (
      <div className="p-4 lg:p-0">
        <LoadError error={members.error} onRetry={() => void members.refetch()} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t('admin.members.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('admin.members.activeShares', { count: totalShares })}</p>
      </div>

      {/* Notice placeholder until rule-conflict feature is built */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[#F0DDAE] bg-warn-bg px-4 py-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-white text-warn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18h.01" /></svg>
        </span>
        <span className="flex-1 text-sm leading-relaxed text-foreground">
          <b className="text-warn">{t('admin.members.ruleConflictHead')}</b> {t('admin.members.ruleConflictBody')}
        </span>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {/* Table */}
        <section className="min-w-0 flex-[2] rounded-[20px] border border-border bg-card p-2 shadow-sm lg:p-4">
          <div className="overflow-x-auto">
            <div className="min-w-[620px]">
              <div className="grid grid-cols-[minmax(0,1.5fr)_64px_minmax(0,1.5fr)_110px_100px_80px] items-center gap-3 border-b border-border px-4 py-2 text-xs font-semibold text-muted">
                <span>{t('admin.members.member')}</span>
                <span>{t('admin.members.shares')}</span>
                <span>{t('common.status')}</span>
                <span>{t('admin.members.capital')}</span>
                <span>{t('admin.members.due')}</span>
                <span />
              </div>
              {!members.data ? (
                <ListSkeleton rows={5} />
              ) : (
                members.data.items.map((m, i) => {
                  const chip = statusChip(m.status, t);
                  const due = BigInt(m.outstanding_principal_paisa) + BigInt(m.outstanding_fines_paisa);
                  const colors = MEMBER_AVATAR_COLORS[i % MEMBER_AVATAR_COLORS.length]!;
                  const isSelected = selected?.id === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSelectedId(m.id)}
                      className={`grid w-full grid-cols-[minmax(0,1.5fr)_64px_minmax(0,1.5fr)_110px_100px_80px] items-center gap-3 border-b border-border px-4 py-3 text-left text-[15px] last:border-b-0 ${
                        isSelected ? 'bg-primary-soft' : 'hover:bg-hover'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 font-semibold">
                        <span className={`grid h-[34px] w-[34px] flex-none place-items-center rounded-full text-[13px] font-bold ${colors.bg} ${colors.fg}`}>
                          {initial(m.full_name)}
                        </span>
                        {m.full_name}
                      </span>
                      <span>{m.shares}</span>
                      <span>
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${chip.bg} ${chip.fg}`}>{chip.label}</span>
                      </span>
                      <span>{taka(m.capital_paisa)}</span>
                      <span className={due > 0n ? 'text-bad' : 'text-muted'}>{taka(due)}</span>
                      <span className="text-sm font-semibold text-primary">{t('common.details')} ›</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </section>

        {/* Detail panel */}
        <aside className="min-w-0 flex-1 rounded-[20px] border border-border bg-card p-5 shadow-sm">
          {!selected ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 flex-none place-items-center rounded-full bg-bad-bg text-[17px] font-bold text-bad">
                  {initial(selected.full_name)}
                </span>
                <div>
                  <div className="text-lg font-bold">
                    {selected.full_name} · {t('admin.members.shareCount', { count: selected.shares })}
                  </div>
                  {(() => {
                    const chip = statusChip(selected.status, t);
                    return (
                      <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${chip.bg} ${chip.fg}`}>{chip.label}</span>
                    );
                  })()}
                </div>
              </div>

              <div className="mt-4 space-y-1">
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span className="text-muted">{t('admin.members.joined')}</span>
                  <span className="font-medium">{selected.joined_on ?? '—'}</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span className="text-muted">{t('admin.members.phone')}</span>
                  <span className="font-medium">{selected.phone ?? '—'}</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span className="text-muted">{t('admin.members.capital')}</span>
                  <span className="font-medium">{taka(selected.capital_paisa)}</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span className="text-muted">{t('admin.members.due')}</span>
                  <span className={`font-medium ${BigInt(selected.outstanding_principal_paisa) + BigInt(selected.outstanding_fines_paisa) > 0n ? 'text-bad' : ''}`}>
                    {taka(BigInt(selected.outstanding_principal_paisa) + BigInt(selected.outstanding_fines_paisa))}
                  </span>
                </div>
              </div>

              <div className="mt-5 text-[15px] font-bold">{t('admin.members.declarationSteps')}</div>
              <div className="mt-1 space-y-1">
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span>{t('admin.members.contactAttempts')}</span>
                  <span className="text-foreground">—</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span>{t('admin.members.registeredLetter')}</span>
                  <span className="text-foreground">—</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border py-2.5 text-sm">
                  <span>{t('admin.members.wait30Days')}</span>
                  <span className="text-foreground">—</span>
                </div>
              </div>

              <div className="mt-5 flex flex-col gap-2.5">
                <button type="button" className="min-h-[48px] rounded-[14px] border-[1.5px] border-primary bg-white px-4 text-[15px] font-bold text-primary">
                  {t('admin.members.addContactLog')}
                </button>
                <button type="button" className="min-h-[48px] rounded-[14px] border-[1.5px] border-primary bg-white px-4 text-[15px] font-bold text-primary">
                  {t('admin.members.settlementProposal')}
                </button>
                <button type="button" disabled className="min-h-[48px] cursor-not-allowed rounded-[14px] bg-soft px-4 text-[15px] font-bold text-muted">
                  {t('admin.members.declareInactive')}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
