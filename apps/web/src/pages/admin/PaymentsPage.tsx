import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS } from '@barakah/shared';
import { AuthedImage } from '../../components/AuthedImage';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtInstant } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';
import type { Page, PaymentDetail, PaymentRow, PaymentStatus } from '../../lib/types';
import { ApprovalsTab } from './payments/ApprovalsTab';
import { EntrySheet, type EntryPrefill } from './payments/EntrySheet';
import { SmsPanel, type SmsResult } from './payments/SmsPanel';

type Action = { kind: 'approve' | 'reject' | 'reverse'; row: PaymentRow } | { kind: 'bulk' } | null;

const SOURCE_KEY = { member_submitted: 'sourceMember', cashier_entry: 'sourceCashier', sms_match: 'sourceSms', import: 'sourceImport' } as const;

/** Payment queue (spec 8): filters, proof thumbnails, pasted-SMS suggestions, J/K/A/R, bulk approve. */
export function PaymentsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'approvals' ? 'approvals' : 'queue';
  const isCashier = !!me?.roles.includes('cashier');

  const [status, setStatus] = useState<PaymentStatus | ''>('pending');
  const [cursorIdx, setCursorIdx] = useState(0);
  const [action, setAction] = useState<Action>(null);
  const [entry, setEntry] = useState<{ prefill: EntryPrefill | null } | null>(null);
  const [exact, setExact] = useState<Set<string>>(new Set());
  const [possible, setPossible] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: ['payments', 'queue', status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<PaymentRow>>(`/payments?limit=50${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const selected = rows[Math.min(cursorIdx, Math.max(rows.length - 1, 0))];

  const bulkRows = rows.filter((r) => r.status === 'pending' && exact.has(r.id));

  const refreshAll = useCallback(() => qc.invalidateQueries(), [qc]);

  const onResults = (results: SmsResult[]) => {
    const e = new Set<string>();
    const p = new Set<string>();
    for (const r of results) for (const m of r.result.matches) (m.exact ? e : p).add(m.payment_id);
    setExact(e);
    setPossible(p);
    // Bring the best match into view.
    const first = rows.findIndex((r) => e.has(r.id) || p.has(r.id));
    if (first >= 0) setCursorIdx(first);
  };

  // Keyboard: J/K move, A approve, R reject (not while typing or while a sheet is open).
  useEffect(() => {
    if (tab !== 'queue' || !isCashier) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (action || entry || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j') setCursorIdx((i) => Math.min(i + 1, rows.length - 1));
      else if (k === 'k') setCursorIdx((i) => Math.max(i - 1, 0));
      else if ((k === 'a' || k === 'r') && selected?.status === 'pending') {
        setReason('');
        setNotice(null);
        setAction({ kind: k === 'a' ? 'approve' : 'reject', row: selected });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, isCashier, action, entry, rows.length, selected]);

  const done = async (text: string) => {
    setNotice(text);
    setReason('');
    await refreshAll();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{t('paymentsPage.title')}</h1>
        <div role="tablist" className="flex gap-1">
          {(['queue', 'approvals'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setParams(k === 'queue' ? {} : { tab: k })} className={`h-11 rounded-md px-4 ${tab === k ? 'bg-primary-soft font-medium text-primary' : 'border border-border'}`}>
              {t(`paymentsPage.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'approvals' ? (
        <ApprovalsTab />
      ) : (
        <>
          {isCashier && (
            <SmsPanel onResults={onResults} onCreate={(r) => setEntry({ prefill: { parsed: r.result, rawSms: r.text } })} />
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted">
              {t('paymentsPage.filterStatus')}{' '}
              <select className="h-11 rounded-md border border-input bg-background px-2 text-foreground" value={status} onChange={(e) => { setStatus(e.target.value as PaymentStatus | ''); setCursorIdx(0); }}>
                <option value="">{t('common.all')}</option>
                {(['pending', 'confirmed', 'rejected', 'reversed'] as const).map((s) => (
                  <option key={s} value={s}>{t(`payment.status.${s}`)}</option>
                ))}
              </select>
            </label>
            {isCashier && (
              <>
                <button type="button" className="h-11 rounded-xl border border-border px-4" onClick={() => { setNotice(null); setEntry({ prefill: null }); }}>
                  {t('paymentsPage.entryTitle')}
                </button>
                {bulkRows.length > 0 && (
                  <button type="button" className="h-11 rounded-xl bg-primary px-4 font-medium text-primary-foreground" onClick={() => { setNotice(null); setAction({ kind: 'bulk' }); }}>
                    {t('paymentsPage.bulkApprove', { n: formatCount(bulkRows.length) })}
                  </button>
                )}
                <span className="hidden text-sm text-muted lg:inline">{t('paymentsPage.shortcuts')}</span>
              </>
            )}
          </div>

          {notice && <p role="status" className="text-ok">{notice}</p>}

          {q.error ? (
            <LoadError error={q.error} onRetry={() => void q.refetch()} />
          ) : !q.data ? (
            <ListSkeleton rows={4} />
          ) : rows.length === 0 ? (
            <Empty text={t('paymentsPage.empty')} />
          ) : (
            <ul className="space-y-2">
              {rows.map((r, i) => (
                <li
                  key={r.id}
                  aria-current={r === selected}
                  onClick={() => setCursorIdx(i)}
                  className={`rounded-lg border bg-card p-3 ${r === selected ? 'border-primary ring-1 ring-ring' : 'border-border'}`}
                >
                  <div className="flex flex-wrap items-start gap-3">
                    {r.proof_file_id ? (
                      <AuthedImage fileId={r.proof_file_id} alt={t('paymentsPage.proof')} className="h-16 w-16" />
                    ) : (
                      <div className="flex h-16 w-16 items-center justify-center rounded-md bg-hover text-center text-xs text-muted">{t('paymentsPage.noProof')}</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">
                        {r.member_code} {r.member_name} · {taka(r.amount_paisa)}
                      </p>
                      <p className="text-sm text-muted">
                        {PAYMENT_METHOD_LABELS[r.method].bn} · {fmtInstant(r.paid_at)} · {t(`paymentsPage.${SOURCE_KEY[r.source]}`)}
                        {r.trx_id && <> · <span className="select-all">{r.trx_id}</span></>}
                      </p>
                      {r.note && <p className="text-sm">{r.note}</p>}
                      {r.reject_reason && <p className="text-sm text-bad">{r.reject_reason}</p>}
                      {exact.has(r.id) && <p className="text-sm font-medium text-ok">✓ {t('paymentsPage.exactMatch')}</p>}
                      {!exact.has(r.id) && possible.has(r.id) && <p className="text-sm font-medium text-warn">{t('paymentsPage.possibleMatch')}</p>}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <StatusPill status={r.status} />
                      {isCashier && r.status === 'pending' && (
                        <div className="flex gap-2">
                          <button type="button" className="h-10 rounded-xl bg-primary px-3 text-primary-foreground" onClick={() => { setNotice(null); setAction({ kind: 'approve', row: r }); }}>
                            {t('paymentsPage.approve')}
                          </button>
                          <button type="button" className="h-10 rounded-xl border border-border px-3" onClick={() => { setReason(''); setNotice(null); setAction({ kind: 'reject', row: r }); }}>
                            {t('paymentsPage.reject')}
                          </button>
                        </div>
                      )}
                      {isCashier && r.status === 'confirmed' && (
                        <button type="button" className="h-10 rounded-xl border border-border px-3" onClick={() => { setReason(''); setNotice(null); setAction({ kind: 'reverse', row: r }); }}>
                          {t('paymentsPage.reverse')}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {q.hasNextPage && (
            <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} className="h-11 w-full rounded-xl border border-border">
              {t('common.loadMore')}
            </button>
          )}
        </>
      )}

      <ApproveSheet action={action} onClose={() => setAction(null)} onDone={() => done(t('paymentsPage.confirmed'))} />
      <BulkSheet open={action?.kind === 'bulk'} rows={bulkRows} onClose={() => setAction(null)} onDone={() => done(t('paymentsPage.confirmed'))} />

      <ConfirmSheet
        open={action?.kind === 'reject'}
        onClose={() => setAction(null)}
        title={t('paymentsPage.rejectTitle')}
        confirmLabel={t('paymentsPage.reject')}
        tone="danger"
        canConfirm={reason.trim().length >= 3}
        onConfirm={async () => {
          if (action?.kind !== 'reject') return;
          await api(`/payments/${action.row.id}/reject`, { method: 'POST', body: { reason: reason.trim() } });
          await done(t('paymentsPage.rejected'));
        }}
      >
        {action?.kind === 'reject' && <PaymentSummary row={action.row} />}
        <textarea aria-label={t('paymentsPage.rejectReason')} placeholder={t('paymentsPage.rejectReason')} className="min-h-20 w-full rounded-md border border-input bg-background p-2" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmSheet>

      <ConfirmSheet
        open={action?.kind === 'reverse'}
        onClose={() => setAction(null)}
        title={t('paymentsPage.reverseTitle')}
        confirmLabel={t('paymentsPage.reverse')}
        tone="danger"
        canConfirm={reason.trim().length >= 3}
        onConfirm={async () => {
          if (action?.kind !== 'reverse') return;
          await api(`/payments/${action.row.id}/reverse-request`, { method: 'POST', body: { reason: reason.trim() } });
          await done(t('paymentsPage.reverseSent'));
        }}
      >
        {action?.kind === 'reverse' && <PaymentSummary row={action.row} />}
        <p className="text-muted">{t('paymentsPage.reverseBody')}</p>
        <textarea aria-label={t('common.reason')} placeholder={t('common.reason')} className="min-h-20 w-full rounded-md border border-input bg-background p-2" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmSheet>

      <EntrySheet open={!!entry} onClose={() => setEntry(null)} prefill={entry?.prefill ?? null} onDone={() => setNotice(t('paymentsPage.entered'))} />
    </div>
  );
}

function PaymentSummary({ row }: { row: PaymentRow }) {
  return (
    <>
      <SheetRow label={`${row.member_code} ${row.member_name}`} value={taka(row.amount_paisa)} strong />
      <SheetRow label={PAYMENT_METHOD_LABELS[row.method].bn} value={row.trx_id ?? ''} />
    </>
  );
}

/** Confirmation sheet for one payment: loads the server's preview of the default allocation. */
function ApproveSheet({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const open = action?.kind === 'approve';
  const row = open ? action.row : null;
  const detail = useQuery({ queryKey: ['payment', row?.id], enabled: !!row, queryFn: () => api<PaymentDetail>(`/payments/${row?.id}`) });
  const preview = detail.data?.preview;

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={t('paymentsPage.approveTitle')}
      confirmLabel={t('paymentsPage.approve')}
      canConfirm={!!preview}
      onConfirm={async () => {
        if (!row) return;
        await api(`/payments/${row.id}/confirm`, { method: 'POST', body: {} });
        await onDone();
      }}
    >
      {row && <PaymentSummary row={row} />}
      {detail.error && <LoadError error={detail.error} />}
      {!preview && !detail.error && <ListSkeleton rows={1} />}
      {preview && (
        <div className="rounded-md bg-background p-3">
          <p className="mb-1 text-sm text-muted">{t('paymentsPage.approveEffect')}</p>
          <SheetRow label={t('paymentsPage.toPrincipal')} value={taka(preview.principal_paisa)} />
          <SheetRow label={t('paymentsPage.toFines')} value={taka(preview.fine_paisa)} />
          <SheetRow label={t('paymentsPage.toCredit')} value={taka(preview.credit_paisa)} />
        </div>
      )}
      {row && me && row.member_id === me.member_id && <p className="text-warn">{t('paymentsPage.selfPayment')}</p>}
    </ConfirmSheet>
  );
}

/** Approve every pending payment that matched its SMS exactly, one after another. */
function BulkSheet({ open, rows, onClose, onDone }: { open: boolean; rows: PaymentRow[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={t('paymentsPage.bulkTitle')}
      confirmLabel={t('paymentsPage.bulkApprove', { n: formatCount(rows.length) })}
      onConfirm={async () => {
        try {
          for (const r of rows) await api(`/payments/${r.id}/confirm`, { method: 'POST', body: {} });
        } finally {
          // Some may have gone through before a failure: always reload what the server says.
          await onDone();
        }
      }}
    >
      <p className="text-muted">{t('paymentsPage.bulkBody')}</p>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex justify-between gap-3 py-1">
            <span>{r.member_code} · {r.trx_id}</span>
            <span className="font-medium">{taka(r.amount_paisa)}</span>
          </li>
        ))}
      </ul>
    </ConfirmSheet>
  );
}
