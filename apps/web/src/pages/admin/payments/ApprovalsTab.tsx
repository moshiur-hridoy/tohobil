import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../../components/ConfirmSheet';
import { ListSkeleton } from '../../../components/Skeleton';
import { Empty, LoadError } from '../../../components/StateViews';
import { StatusPill } from '../../../components/StatusPill';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { fmtInstant } from '../../../lib/dates';
import { taka } from '../../../lib/money';
import type { ApprovalRow, Page } from '../../../lib/types';

/** Reversal requests. The cashier asks; only the auditor decides (with a recent authenticator code). */
export function ApprovalsTab() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isAuditor = !!me?.roles.includes('auditor');
  const [target, setTarget] = useState<{ row: ApprovalRow; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: ['approvals', 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<ApprovalRow>>(`/approvals?limit=30${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  const decide = async () => {
    if (!target) return;
    await api(`/approvals/${target.row.id}/${target.action}`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} });
    setNotice(t('paymentsPage.decided'));
    setNote('');
    await qc.invalidateQueries();
  };

  if (q.error) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <ListSkeleton rows={3} />;
  if (rows.length === 0) return <Empty text={t('paymentsPage.noApprovals')} />;

  return (
    <div className="space-y-3">
      {notice && <p role="status" className="text-ok">{notice}</p>}
      <ul className="space-y-2">
        {rows.map((a) => (
          <li key={a.id} className="rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                {a.payment_member_code} · {a.payment_amount_paisa ? taka(a.payment_amount_paisa) : ''}
                {a.payment_method && <span className="font-normal text-muted"> · {PAYMENT_METHOD_LABELS[a.payment_method as keyof typeof PAYMENT_METHOD_LABELS].bn}</span>}
              </span>
              <StatusPill status={a.status === 'pending' ? 'pending' : a.status === 'approved' ? 'confirmed' : 'rejected'} label={a.status} />
            </div>
            <p className="text-sm text-muted">{t('paymentsPage.requestedBy', { code: a.requested_by_code ?? '?' })} · {fmtInstant(a.created_at)}</p>
            {a.reason && <p className="mt-1">{a.reason}</p>}
            {a.status === 'pending' && isAuditor && (
              <div className="mt-2 flex gap-2">
                <button type="button" className="h-11 rounded-md bg-primary px-4 font-medium text-primary-foreground" onClick={() => { setNotice(null); setTarget({ row: a, action: 'approve' }); }}>
                  {t('paymentsPage.approveReversal')}
                </button>
                <button type="button" className="h-11 rounded-md border border-border px-4" onClick={() => { setNotice(null); setTarget({ row: a, action: 'reject' }); }}>
                  {t('paymentsPage.rejectReversal')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <button type="button" onClick={() => void q.fetchNextPage()} className="h-11 w-full rounded-md border border-border">{t('common.loadMore')}</button>
      )}

      <ConfirmSheet
        open={!!target}
        onClose={() => setTarget(null)}
        title={target?.action === 'approve' ? t('paymentsPage.reversalTitle') : t('paymentsPage.rejectReversal')}
        confirmLabel={target?.action === 'approve' ? t('paymentsPage.approveReversal') : t('paymentsPage.rejectReversal')}
        tone={target?.action === 'approve' ? 'danger' : 'primary'}
        onConfirm={decide}
      >
        {target && (
          <>
            <SheetRow label={target.row.payment_member_code ?? ''} value={target.row.payment_amount_paisa ? taka(target.row.payment_amount_paisa) : ''} strong />
            {target.row.reason && <SheetRow label={t('common.reason')} value={target.row.reason} />}
            {target.action === 'approve' && <p className="text-muted">{t('paymentsPage.reversalEffect')}</p>}
            <textarea aria-label={t('paymentsPage.decisionNote')} placeholder={t('paymentsPage.decisionNote')} className="min-h-20 w-full rounded-md border border-input bg-background p-2" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </>
        )}
      </ConfirmSheet>
    </div>
  );
}
