import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { BTN_SECONDARY, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, ICONS, MemberBadge, Notice } from '../../components/admin';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { formatCount, localDigits } from '../../lib/format';
import { taka } from '../../lib/money';
import type { ObjectionRow, Page } from '../../lib/types';
import { LedgerView } from '../shared/LedgerView';

/** Cashier and auditor ledger: the full table plus the open objections the auditor answers. */
export function AdminLedgerPage() {
  return (
    <LedgerView variant="admin">
      <ObjectionsPanel />
    </LedgerView>
  );
}

function ObjectionsPanel() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isAuditor = !!me?.roles.includes('auditor');
  const [target, setTarget] = useState<{ row: ObjectionRow; status: 'resolved' | 'dismissed' } | null>(null);
  const [answer, setAnswer] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: ['objections', 'panel'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<ObjectionRow>>(`/objections?status=open&limit=30${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  // Nothing open is the normal state: the panel only takes space when there is something to answer.
  if (q.data && rows.length === 0 && !notice) return null;

  return (
    <Card aria-labelledby="objections-title" className="border-bad px-5 pb-3 pt-5 sm:px-6">
      <CardHead
        id="objections-title"
        icon={ICONS.flag}
        tone="bg-bad-bg text-bad"
        title={t('adminLedger.objections')}
        action={q.data && rows.length > 0 ? <span className="rounded-full bg-bad-bg px-2.5 py-0.5 text-xs font-bold text-bad tabular-nums">{formatCount(rows.length)}{q.hasNextPage ? '+' : ''}</span> : undefined}
      />
      <Notice text={notice} className="mb-3" />
      {q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <ListSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <p className="py-3 text-sm text-muted">{t('adminLedger.noObjections')}</p>
      ) : (
        <ul>
          {rows.map((o) => (
            <li key={o.id} className="flex flex-wrap items-start gap-3 border-b border-border py-3 last:border-b-0">
              <MemberBadge code={o.member_code} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {t('adminLedger.entry', { seq: localDigits(o.ledger_seq) })} · {taka(o.entry_amount_paisa)}
                  <span className="ml-2 font-mono text-xs font-normal text-muted">{o.entry_debit} → {o.entry_credit}</span>
                </p>
                <p className="text-xs text-muted">{o.member_name} · {fmtDate(o.created_at.slice(0, 10))}</p>
                <p className="mt-1 text-sm">{o.text}</p>
              </div>
              {isAuditor && (
                <div className="flex gap-2">
                  <button type="button" className={BTN_SM_PRIMARY} onClick={() => { setNotice(null); setAnswer(''); setTarget({ row: o, status: 'resolved' }); }}>{t('adminLedger.resolve')}</button>
                  <button type="button" className={BTN_SM} onClick={() => { setNotice(null); setAnswer(''); setTarget({ row: o, status: 'dismissed' }); }}>{t('adminLedger.dismiss')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <button type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} className={`${BTN_SECONDARY} mb-2 mt-3 w-full`}>{t('common.loadMore')}</button>
      )}

      <ConfirmSheet
        open={!!target}
        onClose={() => setTarget(null)}
        title={t('adminLedger.answerTitle')}
        confirmLabel={target?.status === 'resolved' ? t('adminLedger.resolve') : t('adminLedger.dismiss')}
        canConfirm={answer.trim().length >= 3}
        onConfirm={async () => {
          if (!target) return;
          await api(`/objections/${target.row.id}`, { method: 'PATCH', body: { status: target.status, resolution: answer.trim() } });
          setNotice(t('adminLedger.answered'));
          await qc.invalidateQueries();
        }}
      >
        {target && (
          <>
            <SheetRow label={t('adminLedger.entry', { seq: localDigits(target.row.ledger_seq) })} value={taka(target.row.entry_amount_paisa)} strong />
            <p className="text-muted">{target.row.text}</p>
          </>
        )}
        <textarea aria-label={t('adminLedger.answer')} placeholder={t('adminLedger.answer')} className="field min-h-24 w-full" maxLength={1000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </ConfirmSheet>
    </Card>
  );
}
