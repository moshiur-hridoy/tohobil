import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS } from '@barakah/shared';
import { AuthedImage } from '../../components/AuthedImage';
import {
  AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, ICONS, InfoRow, MemberBadge, Notice, Segmented, SplitLayout,
} from '../../components/admin';
import { Icon } from '../../components/ui';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtInstant, fmtPeriod } from '../../lib/dates';
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
  const [smsOpen, setSmsOpen] = useState(false);

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

  const statusOptions = (['pending', 'confirmed', 'rejected', 'reversed', 'all'] as const).map((v) => ({
    value: v,
    label: v === 'all' ? t('common.all') : t(`payment.status.${v}`),
  }));
  const pick = (i: number) => {
    setCursorIdx(i);
    setNotice(null);
  };
  const act = (kind: 'approve' | 'reject' | 'reverse', row: PaymentRow) => {
    setReason('');
    setNotice(null);
    setAction({ kind, row });
  };

  return (
    <AdminPage>
      <AdminHeader
        title={t('paymentsPage.title')}
        subtitle={t('adminUi.sub.payments')}
        actions={
          <>
            <Segmented
              label={t('paymentsPage.title')}
              value={tab}
              options={(['queue', 'approvals'] as const).map((k) => ({ value: k, label: t(`paymentsPage.${k}`) }))}
              onChange={(k) => { setNotice(null); setParams(k === 'queue' ? {} : { tab: k }); }}
            />
            {/* Both tabs: a payment may need entering while reversal requests are open. */}
            {isCashier && (
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => {
                  setNotice(null);
                  // The matches are marked in the queue, so the SMS reader always works from there.
                  if (tab !== 'queue') setParams({});
                  setSmsOpen(true);
                }}
              >
                <Icon d={ICONS.message} size={18} />
                {t('paymentsPage.fromSms')}
              </button>
            )}
            {isCashier && (
              <button type="button" className={BTN_PRIMARY} onClick={() => { setNotice(null); setEntry({ prefill: null }); }}>
                <Icon d={ICONS.plus} size={18} sw={2} />
                {t('paymentsPage.entryTitle')}
              </button>
            )}
            {tab === 'queue' && isCashier && bulkRows.length > 0 && (
              <button type="button" className={BTN_PRIMARY} onClick={() => { setNotice(null); setAction({ kind: 'bulk' }); }}>
                <Icon d={ICONS.check} size={18} sw={2} />
                {t('paymentsPage.bulkApprove', { n: formatCount(bulkRows.length) })}
              </button>
            )}
          </>
        }
      />

      <Notice text={notice} />

      {tab === 'approvals' ? (
        <ApprovalsTab />
      ) : (
        <>
          <SplitLayout
            sideWidth="360px"
            main={
              <Card className="px-5 pb-3 pt-5 sm:px-6">
                <CardHead
                  title={t('paymentsPage.queue')}
                  sub={isCashier ? <span className="hidden lg:inline">{t('paymentsPage.shortcuts')}</span> : undefined}
                  action={
                    <Segmented
                      label={t('adminUi.payments.statusLabel')}
                      value={status || 'all'}
                      options={statusOptions}
                      onChange={(v) => { setStatus(v === 'all' ? '' : v); setCursorIdx(0); }}
                    />
                  }
                />
                {q.error ? (
                  <LoadError error={q.error} onRetry={() => void q.refetch()} />
                ) : !q.data ? (
                  <ListSkeleton rows={4} />
                ) : rows.length === 0 ? (
                  <EmptyCard text={t('paymentsPage.empty')} />
                ) : (
                  <ul>
                    {rows.map((r, i) => (
                      <QueueRow
                        key={r.id}
                        r={r}
                        selected={r === selected}
                        match={exact.has(r.id) ? 'exact' : possible.has(r.id) ? 'possible' : null}
                        isCashier={isCashier}
                        onPick={() => pick(i)}
                        onAct={(kind) => act(kind, r)}
                      />
                    ))}
                  </ul>
                )}
                {q.hasNextPage && (
                  <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} className={`${BTN_SECONDARY} mb-2 mt-3 w-full`}>
                    {t('common.loadMore')}
                  </button>
                )}
              </Card>
            }
            side={
              <PaymentPanel
                row={selected ?? null}
                match={selected ? (exact.has(selected.id) ? 'exact' : possible.has(selected.id) ? 'possible' : null) : null}
                isCashier={isCashier}
                onAct={(kind) => selected && act(kind, selected)}
              />
            }
          />
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
        <textarea aria-label={t('paymentsPage.rejectReason')} placeholder={t('paymentsPage.rejectReason')} className="field min-h-20 w-full" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
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
        <textarea aria-label={t('common.reason')} placeholder={t('common.reason')} className="field min-h-20 w-full" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </ConfirmSheet>

      <AdminDialog open={smsOpen} onClose={() => setSmsOpen(false)} title={t('paymentsPage.pasteSms')} wide>
        <SmsPanel
          onResults={onResults}
          onCreate={(r) => {
            setSmsOpen(false);
            setEntry({ prefill: { parsed: r.result, rawSms: r.text } });
          }}
        />
        {exact.size > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ok-bg p-3 text-sm text-ok">
            <span className="font-medium">{t('paymentsPage.smsMatchedHint', { n: formatCount(exact.size) })}</span>
            <button type="button" className={BTN_SECONDARY} onClick={() => setSmsOpen(false)}>
              {t('paymentsPage.showInQueue')}
            </button>
          </div>
        )}
      </AdminDialog>

      <EntrySheet open={!!entry} onClose={() => setEntry(null)} prefill={entry?.prefill ?? null} onDone={() => setNotice(t('paymentsPage.entered'))} />
    </AdminPage>
  );
}

type Match = 'exact' | 'possible' | null;

function MatchLine({ match }: { match: Match }) {
  const { t } = useTranslation();
  if (match === 'exact') return <p className="text-xs font-semibold text-ok">✓ {t('paymentsPage.exactMatch')}</p>;
  if (match === 'possible') return <p className="text-xs font-semibold text-warn">◔ {t('paymentsPage.possibleMatch')}</p>;
  return null;
}

/**
 * One payment in the queue. The row selects it for the side panel; below `xl` (no side panel next to
 * the list) the row carries its own approve / reject / reverse buttons.
 */
function QueueRow({ r, selected, match, isCashier, onPick, onAct }: {
  r: PaymentRow;
  selected: boolean;
  match: Match;
  isCashier: boolean;
  onPick: () => void;
  onAct: (kind: 'approve' | 'reject' | 'reverse') => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      aria-current={selected}
      onClick={onPick}
      className={`-mx-2 flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border-b border-border px-2 py-3 transition-colors last:border-b-0 ${selected ? 'bg-primary-soft' : 'hover:bg-hover'}`}
    >
      {/* the click bubbles to the row; the button makes the row reachable by keyboard */}
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <MemberBadge code={r.member_code} />
        <span className="min-w-0">
          <span className="block truncate text-[0.9375rem] font-semibold">{r.member_name}</span>
          <span className="block truncate text-xs text-muted">
            {PAYMENT_METHOD_LABELS[r.method].bn} · {fmtInstant(r.paid_at)}
            {r.trx_id && <> · <span className="font-mono">{r.trx_id}</span></>}
          </span>
          <MatchLine match={match} />
        </span>
      </button>
      <span className="text-right">
        <span className="block text-[0.9375rem] font-bold tabular-nums">{taka(r.amount_paisa)}</span>
        <span className="block text-xs text-muted">{t(`paymentsPage.${SOURCE_KEY[r.source]}`)}</span>
      </span>
      <span className="w-[6.5rem] text-right"><StatusPill status={r.status} /></span>
      {isCashier && (r.status === 'pending' || r.status === 'confirmed') && (
        <div className="flex basis-full justify-end gap-2 xl:hidden" onClick={(e) => e.stopPropagation()}>
          {r.status === 'pending' ? (
            <>
              <button type="button" className={BTN_SM_PRIMARY} onClick={() => onAct('approve')}>{t('paymentsPage.approve')}</button>
              <button type="button" className={BTN_SM} onClick={() => onAct('reject')}>{t('paymentsPage.reject')}</button>
            </>
          ) : (
            <button type="button" className={BTN_SM} onClick={() => onAct('reverse')}>{t('paymentsPage.reverse')}</button>
          )}
        </div>
      )}
    </li>
  );
}

/** The selected payment: proof, details, what approving would do, and the decision buttons. */
function PaymentPanel({ row, match, isCashier, onAct }: { row: PaymentRow | null; match: Match; isCashier: boolean; onAct: (kind: 'approve' | 'reject' | 'reverse') => void }) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: ['payment', row?.id],
    enabled: !!row && row.status === 'pending' && isCashier,
    queryFn: () => api<PaymentDetail>(`/payments/${row?.id}`),
  });
  const preview = detail.data?.preview;

  if (!row) {
    return (
      <Card className="hidden p-5 xl:block">
        <EmptyCard text={t('adminUi.payments.pick')} icon={ICONS.wallet} />
      </Card>
    );
  }

  return (
    <Card className="hidden p-5 xl:block">
      <div className="flex items-center gap-3">
        <MemberBadge code={row.member_code} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{row.member_name}</p>
          <p className="text-[0.8125rem] text-muted">{row.status === 'pending' ? t('adminUi.payments.check') : t(`payment.status.${row.status}`)}</p>
        </div>
        <StatusPill status={row.status} />
      </div>

      <p className="mt-4 text-[2rem] font-bold leading-tight tabular-nums">{taka(row.amount_paisa)}</p>
      <div className="mt-1"><MatchLine match={match} /></div>

      <div className="mt-4">
        {row.proof_file_id ? (
          <AuthedImage fileId={row.proof_file_id} alt={t('paymentsPage.proof')} className="h-48 w-full rounded-xl bg-soft object-contain" />
        ) : (
          <div className="grid h-20 place-items-center rounded-xl border border-dashed border-border text-sm text-muted">{t('paymentsPage.noProof')}</div>
        )}
      </div>

      <dl className="mt-4">
        <InfoRow label={t('paymentsPage.method')} value={PAYMENT_METHOD_LABELS[row.method].bn} />
        <InfoRow label={t('paymentsPage.trxId')} value={row.trx_id ? <span className="select-all font-mono">{row.trx_id}</span> : '—'} />
        <InfoRow label={t('paymentsPage.paidAt')} value={fmtInstant(row.paid_at)} />
        <InfoRow label={t('paymentsPage.source')} value={t(`paymentsPage.${SOURCE_KEY[row.source]}`)} />
        {row.for_periods && row.for_periods.length > 0 && <InfoRow label={t('adminUi.payments.for')} value={row.for_periods.map(fmtPeriod).join(', ')} />}
      </dl>
      {row.note && <p className="mt-2 rounded-xl bg-soft px-3 py-2 text-sm">{row.note}</p>}
      {row.reject_reason && <p className="mt-2 rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">{row.reject_reason}</p>}

      {row.status === 'pending' && isCashier && (
        <div className="mt-4 rounded-xl bg-soft p-3">
          <p className="mb-1 text-xs font-semibold text-muted">{t('paymentsPage.approveEffect')}</p>
          {detail.error ? (
            <LoadError error={detail.error} />
          ) : !preview ? (
            <ListSkeleton rows={1} />
          ) : (
            <dl>
              <InfoRow label={t('paymentsPage.toPrincipal')} value={taka(preview.principal_paisa)} />
              <InfoRow label={t('paymentsPage.toFines')} value={taka(preview.fine_paisa)} />
              <InfoRow label={t('paymentsPage.toCredit')} value={taka(preview.credit_paisa)} />
            </dl>
          )}
        </div>
      )}

      {isCashier && row.status === 'pending' && (
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button type="button" className={BTN_PRIMARY} onClick={() => onAct('approve')}>{t('paymentsPage.approve')}</button>
          <button type="button" className={BTN_SECONDARY} onClick={() => onAct('reject')}>{t('paymentsPage.reject')}</button>
        </div>
      )}
      {isCashier && row.status === 'confirmed' && (
        <button type="button" className={`${BTN_SECONDARY} mt-4 w-full`} onClick={() => onAct('reverse')}>{t('paymentsPage.reverse')}</button>
      )}
    </Card>
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
        <div className="rounded-xl bg-soft p-3">
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
