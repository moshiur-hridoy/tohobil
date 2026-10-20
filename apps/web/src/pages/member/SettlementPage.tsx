import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/dates';
import { taka } from '../../lib/money';
import type { SettlementView } from '../../lib/types';

/** The caller's settlements (everyone's for the cashier and auditor): the numbers that were voted on. */
export function SettlementPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['settlements'], queryFn: () => api<{ items: SettlementView[] }>('/settlements') });

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/menu"
          aria-label={t('common.back')}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="flex-1 pl-1">
          <div className="text-[1.1875rem] font-bold leading-tight">{t('settlement.title')}</div>
          <div className="text-[0.8125rem] text-muted">{t('settlement.subtitle')}</div>
        </div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {q.error ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <ListSkeleton rows={4} />
        ) : q.data.items.length === 0 ? (
          <Empty text={t('settlement.empty')} />
        ) : (
          q.data.items.map((s) => <SettlementCard key={s.id} s={s} />)
        )}
        <p className="text-xs text-muted">{t('settlement.disclaimer')}</p>
      </main>
    </div>
  );
}

function SettlementCard({ s }: { s: SettlementView }) {
  const { t } = useTranslation();
  const lines: Array<{ label: string; value: string; className: string }> = [
    { label: t('settlement.gross'), value: taka(BigInt(s.gross_paisa)), className: '' },
    ...(BigInt(s.escrow_paisa) > 0n ? [{ label: t('settlement.escrow'), value: taka(BigInt(s.escrow_paisa)), className: '' }] : []),
    ...(BigInt(s.principal_paisa) > 0n ? [{ label: t('settlement.unpaidDues'), value: `−${taka(BigInt(s.principal_paisa))}`, className: 'text-bad' }] : []),
    ...(BigInt(s.fines_paisa) > 0n ? [{ label: t('settlement.unpaidFines'), value: `−${taka(BigInt(s.fines_paisa))}`, className: 'text-bad' }] : []),
    ...(BigInt(s.exit_fee_paisa) > 0n ? [{ label: t('settlement.serviceCharge'), value: `−${taka(BigInt(s.exit_fee_paisa))}`, className: 'text-bad' }] : []),
  ];

  return (
    <section className="rounded-[20px] border border-border bg-card p-4 shadow-sm" data-testid="settlement-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[1.0625rem] font-bold">{s.member_code} · {s.member_name}</div>
          <div className="text-[0.8125rem] text-muted">{t(`settlementKind.${s.kind}`)} · {fmtDate(s.taken_on)}</div>
        </div>
        <span className="rounded-full bg-soft px-2.5 py-1 text-xs font-semibold">{t(`settlement.status.${s.status}`)}</span>
      </div>

      <ul>
        {lines.map((l) => (
          <li key={l.label} className={`flex justify-between gap-3 border-t border-border py-2.5 text-[0.9375rem] first:border-t-0 ${l.className}`}>
            <span>{l.label}</span>
            <span>{l.value}</span>
          </li>
        ))}
        <li className="flex justify-between gap-3 border-t border-border py-2.5 text-[0.9375rem] font-bold text-ok">
          <span>{t('settlement.netRefund')}</span>
          <span>{taka(BigInt(s.net_paisa))}</span>
        </li>
      </ul>

      <h2 className="mb-1 mt-3 text-sm font-bold">{t('settlement.payoutPlan')}</h2>
      <ul className="text-[0.9375rem]">
        {s.payouts.map((p) => (
          <li key={p.due_on} className="flex justify-between gap-3 border-t border-border py-2 first:border-t-0">
            <span>{fmtDate(p.due_on)}{p.paid_at ? ` · ${t('settlement.paid')}` : ''}</span>
            <span>{taka(BigInt(p.amount_paisa))}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
