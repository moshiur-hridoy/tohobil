import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../../components/ConfirmSheet';
import { ListSkeleton } from '../../../components/Skeleton';
import { LoadError } from '../../../components/StateViews';
import { BTN_SECONDARY, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, ICONS, MemberBadge, Notice } from '../../../components/admin';
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

  return (
    <Card className="px-5 pb-3 pt-5 sm:px-6">
      <CardHead icon={ICONS.undo} tone="bg-blue-bg text-blue" title={t('paymentsPage.approvals')} />
      <Notice text={notice} className="mb-3" />
      {q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <ListSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyCard text={t('paymentsPage.noApprovals')} />
      ) : (
        <ul>
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-b-0">
              <MemberBadge code={a.payment_member_code ?? '?'} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {a.payment_amount_paisa ? taka(a.payment_amount_paisa) : ''}
                  {a.payment_method && <span className="font-normal text-muted"> · {PAYMENT_METHOD_LABELS[a.payment_method as keyof typeof PAYMENT_METHOD_LABELS].bn}</span>}
                </p>
                <p className="text-xs text-muted">{t('paymentsPage.requestedBy', { code: a.requested_by_code ?? '?' })} · {fmtInstant(a.created_at)}</p>
                {a.reason && <p className="mt-1 text-sm">{a.reason}</p>}
              </div>
              <StatusPill status={a.status === 'pending' ? 'pending' : a.status === 'approved' ? 'confirmed' : 'rejected'} label={a.status} />
              {a.status === 'pending' && isAuditor && (
                <div className="flex basis-full justify-end gap-2 sm:basis-auto">
                  <button type="button" className={BTN_SM_PRIMARY} onClick={() => { setNotice(null); setTarget({ row: a, action: 'approve' }); }}>
                    {t('paymentsPage.approveReversal')}
                  </button>
                  <button type="button" className={BTN_SM} onClick={() => { setNotice(null); setTarget({ row: a, action: 'reject' }); }}>
                    {t('paymentsPage.rejectReversal')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <button type="button" onClick={() => void q.fetchNextPage()} className={`${BTN_SECONDARY} mb-2 mt-3 w-full`}>{t('common.loadMore')}</button>
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
            <textarea aria-label={t('paymentsPage.decisionNote')} placeholder={t('paymentsPage.decisionNote')} className="field min-h-20 w-full" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </>
        )}
      </ConfirmSheet>
    </Card>
  );
}
