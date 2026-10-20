import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { localDigits } from '../../lib/format';
import { taka } from '../../lib/money';
import type { ObjectionRow, Page } from '../../lib/types';
import { LedgerView } from '../shared/LedgerView';

/** Cashier and auditor ledger: the full table plus the open objections the auditor answers. */
export function AdminLedgerPage() {
  return (
    <div className="space-y-8">
      <LedgerView variant="admin" />
      <ObjectionsPanel />
    </div>
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

  return (
    <section aria-labelledby="objections-title" className="space-y-3">
      <h2 id="objections-title" className="text-xl font-semibold">{t('adminLedger.objections')}</h2>
      {notice && <p role="status" className="text-ok">{notice}</p>}
      {q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <ListSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <Empty text={t('adminLedger.noObjections')} />
      ) : (
        <ul className="space-y-2">
          {rows.map((o) => (
            <li key={o.id} className="rounded-[18px] border border-border bg-card shadow-card p-3">
              <p className="font-medium">
                {t('adminLedger.entry', { seq: localDigits(o.ledger_seq) })} · {taka(o.entry_amount_paisa)} · {o.entry_debit} → {o.entry_credit}
              </p>
              <p className="text-sm text-muted">{o.member_code} {o.member_name} · {fmtDate(o.created_at.slice(0, 10))}</p>
              <p className="mt-1">{o.text}</p>
              {isAuditor && (
                <div className="mt-2 flex gap-2">
                  <button type="button" className="h-11 rounded-xl bg-primary px-4 font-medium text-primary-foreground" onClick={() => { setNotice(null); setAnswer(''); setTarget({ row: o, status: 'resolved' }); }}>{t('adminLedger.resolve')}</button>
                  <button type="button" className="h-11 rounded-xl border border-border px-4" onClick={() => { setNotice(null); setAnswer(''); setTarget({ row: o, status: 'dismissed' }); }}>{t('adminLedger.dismiss')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
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
        <textarea aria-label={t('adminLedger.answer')} placeholder={t('adminLedger.answer')} className="min-h-24 w-full rounded-md border border-input bg-background p-2" maxLength={1000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </ConfirmSheet>
    </section>
  );
}
