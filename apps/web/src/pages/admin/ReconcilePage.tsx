import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { periodEnd, tryParseBDT } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, Card, CardHead, ICONS } from '../../components/admin';
import { Icon, Optional } from '../../components/ui';
import { FilePicker } from '../../components/FilePicker';
import { formatCount, localDigits } from '../../lib/format';
import { api, apiBlob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtPeriod, fmtPeriodShort, todayDhaka } from '../../lib/dates';
import { downloadFile } from '../../lib/download';
import { taka } from '../../lib/money';

interface Submitted {
  actual_balance_paisa?: string;
  statement_paisa?: string;
  difference_paisa: string;
  note: string | null;
  proof_file_id: string | null;
  approved_at: string | null;
}
interface MonthCheck {
  period: string;
  mode: 'pool' | 'per_method';
  accounts: Array<{ account: string; books_paisa: string; submitted: Submitted | null; stale: boolean }>;
  shops: Array<{ partner_id: string; name: string; sent_paisa: string; purchases: number; submitted: Submitted | null; stale: boolean }>;
  summary: { opening_paisa: string; closing_paisa: string; lines: Array<{ key: string; amount_paisa: string }> };
  counted: boolean;
  approved: boolean;
  stale: boolean;
  locked_at: string | null;
}
interface PeriodRow {
  period: string;
  locked_at: string | null;
  counted_accounts: number;
  approved_accounts: number;
  open_objections: number;
}
/** What the cashier types for one row: the figure, a note when it differs, the statement it came from. */
interface Draft {
  amount: string;
  note: string;
  file: File | null;
}

function previousMonth(): string {
  const [y, m] = todayDhaka().split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

type Sheet = 'submit' | 'approve' | 'lock' | 'request' | 'signoff' | 'archive' | null;
type MonthState = 'locked' | 'approved' | 'counted' | 'todo' | 'future';

const STATE_TONE: Record<MonthState, string> = {
  locked: 'border-ok bg-ok-bg text-ok',
  approved: 'border-blue bg-blue-bg text-blue',
  counted: 'border-warn bg-warn-bg text-warn',
  todo: 'border-border bg-card text-ink2',
  future: 'border-dashed border-border bg-soft text-muted',
};

/**
 * Month-end check (spec 5.12, ASSUMPTIONS 132), as three steps: what happened this month in the
 * books, what is really there (the bank statement, and each shop's statement of what it received),
 * then the auditor's approval and lock. A strip of the year's months shows where each one stands.
 * The year-end audit and archive sit folded at the bottom.
 */
export function ReconcilePage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const isAuditor = me?.roles.includes('auditor') ?? false;
  const [period, setPeriod] = useState(previousMonth());
  const year = period.slice(0, 4);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const month = useQuery({
    queryKey: ['reconciliations', period],
    queryFn: () => api<Partial<MonthCheck>>(`/reconciliations?period=${period}`),
    // the recorded public demo predates the three-step check; fill what it lacks
    select: (r): MonthCheck => ({
      period,
      mode: 'pool',
      accounts: [],
      shops: [],
      summary: { opening_paisa: '0', closing_paisa: '0', lines: [] },
      counted: false,
      approved: false,
      stale: false,
      locked_at: null,
      ...r,
    }),
  });
  const periods = useQuery({ queryKey: ['periods', year], queryFn: () => api<{ items: PeriodRow[] }>(`/periods?year=${year}`) });
  const audit = useQuery({ queryKey: ['audit', year], queryFn: () => api<{ status: string; signed_at: string | null }>(`/periods/${year}/audit`) });

  const today = todayDhaka();
  const ended = periodEnd(period) <= today;
  const m = month.data;
  const row = periods.data?.items.find((p) => p.period === period);
  const accounts = m?.accounts ?? [];
  const shops = m?.shops ?? [];
  const canCount = isCashier && ended && !!m && !m.approved;
  const lockedCount = periods.data?.items.filter((p) => p.locked_at).length ?? 0;
  const auditStatus = audit.data?.status ?? 'none';

  const draft = (key: string): Draft => drafts[key] ?? { amount: '', note: '', file: null };
  const setDraft = (key: string, patch: Partial<Draft>) => setDrafts({ ...drafts, [key]: { ...draft(key), ...patch } });
  const parsed = (key: string) => tryParseBDT(draft(key).amount.trim());
  const diffOf = (key: string, books: string) => {
    const v = parsed(key);
    return v === null ? null : v - BigInt(books);
  };
  const rows = [
    ...accounts.map((a) => ({ key: `acc:${a.account}`, books: a.books_paisa })),
    ...shops.map((s) => ({ key: `shop:${s.partner_id}`, books: s.sent_paisa })),
  ];
  const ready = rows.length > 0 && rows.every((r) => parsed(r.key) !== null && (diffOf(r.key, r.books) === 0n || draft(r.key).note.trim() !== ''));

  const monthState = (p: string): MonthState => {
    if (periodEnd(p) > today) return 'future';
    const r = periods.data?.items.find((x) => x.period === p);
    if (r?.locked_at) return 'locked';
    if (r && r.counted_accounts > 0 && r.approved_accounts === r.counted_accounts) return 'approved';
    if (r && r.counted_accounts > 0) return 'counted';
    return 'todo';
  };

  const upload = async (file: File | null): Promise<string | undefined> => {
    if (!file) return undefined;
    const form = new FormData();
    form.append('file', file);
    return (await api<{ id: string }>('/files', { method: 'POST', body: form })).id;
  };

  const run = async (): Promise<void> => {
    if (sheet === 'submit') {
      const entries = [];
      for (const a of accounts) {
        const d = draft(`acc:${a.account}`);
        const proof = await upload(d.file);
        entries.push({ account: a.account, actual_balance_paisa: String(parsed(`acc:${a.account}`)), ...(d.note.trim() ? { note: d.note.trim() } : {}), ...(proof ? { proof_file_id: proof } : {}) });
      }
      const shopRows = [];
      for (const s of shops) {
        const d = draft(`shop:${s.partner_id}`);
        const proof = await upload(d.file);
        shopRows.push({ partner_id: s.partner_id, statement_paisa: String(parsed(`shop:${s.partner_id}`)), ...(d.note.trim() ? { note: d.note.trim() } : {}), ...(proof ? { proof_file_id: proof } : {}) });
      }
      await api('/reconciliations', { method: 'POST', body: { period, entries, shops: shopRows } });
      setDrafts({});
    } else if (sheet === 'approve') await api(`/reconciliations/${period}/approve`, { method: 'POST' });
    else if (sheet === 'lock') await api(`/periods/${period}/lock`, { method: 'POST' });
    else if (sheet === 'request') await api(`/periods/${year}/audit-request`, { method: 'POST' });
    else if (sheet === 'signoff') await api(`/periods/${year}/audit-signoff`, { method: 'POST' });
    else if (sheet === 'archive') await api(`/periods/${year}/archive`, { method: 'POST' });
    void qc.invalidateQueries();
  };

  const openFile = async (id: string) => {
    window.open(URL.createObjectURL(await apiBlob(`/files/${id}`)), '_blank', 'noopener');
  };

  // Where the month stands, in one sentence, and who acts next.
  const stage: { text: string; tone: string } = !ended
    ? { text: t('reconcile.stage.notEnded'), tone: 'bg-soft text-ink2' }
    : !m
      ? { text: '', tone: '' }
      : m.locked_at
        ? { text: t('reconcile.stage.locked'), tone: 'bg-ok-bg text-ok' }
        : m.stale
          ? { text: t('reconcile.stage.stale'), tone: 'bg-bad-bg text-bad' }
          : !m.counted
            ? { text: t('reconcile.stage.count'), tone: 'bg-warn-bg text-warn' }
            : !m.approved
              ? { text: t('reconcile.stage.approve'), tone: 'bg-blue-bg text-blue' }
              : (row?.open_objections ?? 0) > 0
                ? { text: t('reconcile.openObjections', { count: row!.open_objections }), tone: 'bg-warn-bg text-warn' }
                : { text: t('reconcile.stage.lock'), tone: 'bg-blue-bg text-blue' };

  return (
    <AdminPage>
      <AdminHeader
        title={t('reconcile.title')}
        subtitle={t('reconcile.subtitle')}
        actions={<input type="month" aria-label={t('reconcile.month')} value={period} max={today.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="field w-[10.5rem]" />}
      />

      {/* the year at a glance: tap a month to open it */}
      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
          {Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).map((p) => {
            const st = monthState(p);
            return (
              <button
                key={p}
                type="button"
                disabled={st === 'future'}
                aria-pressed={p === period}
                aria-label={`${fmtPeriod(p)}: ${t(`reconcile.state.${st}`)}`}
                onClick={() => setPeriod(p)}
                className={`flex flex-col items-center rounded-xl border px-1 py-1.5 text-xs font-semibold ${STATE_TONE[st]} ${p === period ? 'ring-2 ring-accent' : ''}`}
              >
                <span>{fmtPeriodShort(p).split(' ')[0]}</span>
                <span aria-hidden="true" className="mt-0.5 text-[0.6875rem]">{st === 'locked' ? '✓' : st === 'approved' ? '✓' : st === 'counted' ? '…' : st === 'todo' ? '•' : ''}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {(['todo', 'counted', 'approved', 'locked'] as const).map((st) => (
            <span key={st} className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-full border ${STATE_TONE[st]}`} />{t(`reconcile.state.${st}`)}</span>
          ))}
        </p>
      </Card>

      {stage.text && (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm font-semibold ${stage.tone}`}>{fmtPeriod(period)}: {stage.text}</p>
      )}

      {month.error ? (
        <LoadError error={month.error} onRetry={() => void month.refetch()} />
      ) : !m ? (
        <ListSkeleton rows={5} />
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* Step 1: what the books say happened */}
          <Card className="p-5">
            <CardHead icon={ICONS.scale} title={<StepTitle n={1} text={t('reconcile.step1')} />} sub={t('reconcile.step1Hint')} />
            <dl>
              <SummaryRow label={t('reconcile.opening')} value={taka(m.summary.opening_paisa)} />
              {m.summary.lines.length === 0 && <p className="border-t border-border py-3 text-sm text-muted">{t('reconcile.noMoves')}</p>}
              {m.summary.lines.map((l) => {
                const v = BigInt(l.amount_paisa);
                return <SummaryRow key={l.key} label={t(`reconcile.line.${l.key}`)} value={`${v > 0n ? '+' : '−'}${taka(v > 0n ? v : -v)}`} valueClass={v > 0n ? 'text-ok' : 'text-bad'} />;
              })}
              <SummaryRow label={t('reconcile.closing')} value={taka(m.summary.closing_paisa)} strong />
            </dl>
          </Card>

          {/* Step 2: what is really there */}
          <Card className="p-5">
            <CardHead icon={ICONS.wallet} title={<StepTitle n={2} text={t('reconcile.step2')} />} sub={t(m.mode === 'pool' ? 'reconcile.step2HintPool' : 'reconcile.step2HintMethod')} />
            {m.stale && <p role="alert" className="mb-3 rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">{t('reconcile.staleWarn')}</p>}
            <ul className="space-y-3">
              {accounts.map((a) => (
                <CheckRow
                  key={a.account}
                  title={m.mode === 'pool' ? t('reconcile.poolTitle') : t(`cashAccount.${a.account}`)}
                  booksLabel={t('reconcile.booksBalance')}
                  books={a.books_paisa}
                  inputLabel={t('reconcile.statementBalance')}
                  submitted={a.submitted}
                  submittedValue={a.submitted?.actual_balance_paisa}
                  stale={a.stale}
                  editable={canCount}
                  draft={draft(`acc:${a.account}`)}
                  diff={diffOf(`acc:${a.account}`, a.books_paisa)}
                  onDraft={(patch) => setDraft(`acc:${a.account}`, patch)}
                  onOpen={openFile}
                />
              ))}
              {shops.map((s) => (
                <CheckRow
                  key={s.partner_id}
                  title={s.name}
                  booksLabel={t('reconcile.sentThisMonth', { n: formatCount(s.purchases) })}
                  books={s.sent_paisa}
                  inputLabel={t('reconcile.shopStatement')}
                  submitted={s.submitted}
                  submittedValue={s.submitted?.statement_paisa}
                  stale={s.stale}
                  editable={canCount}
                  draft={draft(`shop:${s.partner_id}`)}
                  diff={diffOf(`shop:${s.partner_id}`, s.sent_paisa)}
                  onDraft={(patch) => setDraft(`shop:${s.partner_id}`, patch)}
                  onOpen={openFile}
                />
              ))}
            </ul>
            {shops.length === 0 && <p className="mt-3 text-xs text-muted">{t('reconcile.noShops')}</p>}
            {canCount && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" disabled={!ready} onClick={() => setSheet('submit')} className={BTN_PRIMARY}>
                  {m.counted ? t('reconcile.resubmit') : t('reconcile.submit')}
                </button>
                {!ready && <span className="text-xs text-muted">{t('reconcile.fillAll')}</span>}
              </div>
            )}
          </Card>

          {/* Step 3: the auditor */}
          <Card className="p-5 xl:col-span-2">
            <CardHead icon={ICONS.shield} tone="bg-blue-bg text-blue" title={<StepTitle n={3} text={t('reconcile.step3')} />} sub={t('reconcile.step3Hint')} />
            <ol className="text-sm">
              <StepLine done={m.counted && !m.stale} text={t('reconcile.done.counted')} />
              <StepLine done={m.approved} text={t('reconcile.done.approved')} />
              <StepLine done={!!m.locked_at} text={t('reconcile.done.locked')} />
            </ol>
            {isAuditor && !m.locked_at && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {!m.approved && (
                  <button type="button" disabled={!m.counted || m.stale} onClick={() => setSheet('approve')} className={BTN_PRIMARY}>{t('reconcile.approve')}</button>
                )}
                {m.approved && (
                  <button type="button" disabled={(row?.open_objections ?? 0) > 0} onClick={() => setSheet('lock')} className={BTN_PRIMARY}>{t('reconcile.lock')}</button>
                )}
              </div>
            )}
            {!isAuditor && !m.locked_at && m.counted && <p className="mt-3 text-xs text-muted">{t('reconcile.auditorDoes')}</p>}
          </Card>
        </div>
      )}

      {/* Year end: folded away until it matters */}
      <details className="group rounded-[20px] border border-border bg-card shadow-card" open={lockedCount === 12}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
          <span className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-blue-bg text-blue"><Icon d={ICONS.lock} size={18} /></span>
            <span>
              <span className="block font-bold">{t('reconcile.yearEnd')} · {localDigits(year)}</span>
              <span className="block text-xs text-muted">{t('reconcile.lockedMonths', { count: lockedCount })} · {t(`reconcile.auditStatus.${auditStatus}`)}</span>
            </span>
          </span>
          <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="border-t border-border p-5 pt-3">
          <ol>
            <StepLine done={lockedCount === 12} text={t('reconcile.lockedMonths', { count: lockedCount })} />
            <StepLine done={auditStatus === 'approved'} text={`${t('reconcile.audit')}: ${t(`reconcile.auditStatus.${auditStatus}`)}`} />
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            {isCashier && auditStatus === 'none' && <button type="button" disabled={lockedCount !== 12} onClick={() => setSheet('request')} className={BTN_PRIMARY}>{t('reconcile.requestAudit')}</button>}
            {isAuditor && auditStatus === 'pending' && <button type="button" onClick={() => setSheet('signoff')} className={BTN_PRIMARY}>{t('reconcile.signAudit')}</button>}
            {isCashier && auditStatus === 'approved' && <button type="button" onClick={() => setSheet('archive')} className={BTN_PRIMARY}>{t('reconcile.createArchive')}</button>}
            {auditStatus === 'approved' && (
              <button type="button" onClick={() => void downloadFile(`/reports/annual?year=${year}`, `barakah-${year}.zip`).catch(() => undefined)} className={BTN_SECONDARY}>
                <Icon d={ICONS.download} size={18} />
                {t('reconcile.downloadArchive')}
              </button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">{t('reconcile.yearHint')}</p>
        </div>
      </details>

      <ConfirmSheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet ? t(`reconcile.sheet.${sheet}`) : ''}
        confirmLabel={t('common.confirm')}
        onConfirm={run}
      >
        <p className="text-muted">{sheet === 'submit' || sheet === 'approve' || sheet === 'lock' ? fmtPeriod(period) : localDigits(year)}</p>
        {sheet === 'submit' && <p className="text-sm text-muted">{t('reconcile.submitWarning')}</p>}
        {sheet === 'approve' && <p className="text-sm text-muted">{t('reconcile.approveWarning')}</p>}
        {sheet === 'lock' && <p className="text-sm text-muted">{t('reconcile.lockWarning')}</p>}
        {sheet === 'archive' && <p className="text-sm text-muted">{t('reconcile.archiveWarning')}</p>}
      </ConfirmSheet>
    </AdminPage>
  );
}

function StepTitle({ n, text }: { n: number; text: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-fill text-xs font-bold text-on-accent">{localDigits(String(n))}</span>
      {text}
    </span>
  );
}

function SummaryRow({ label, value, valueClass = '', strong = false }: { label: string; value: string; valueClass?: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 border-t border-border py-2.5 text-sm first:border-t-0 ${strong ? 'border-t-2 font-bold' : ''}`}>
      <dt className={strong ? '' : 'text-ink2'}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base' : 'font-semibold'} ${valueClass}`}>{value}</dd>
    </div>
  );
}

function StepLine({ done, text }: { done: boolean; text: string }) {
  return (
    <li className="flex min-h-10 items-center gap-3 border-t border-border first:border-t-0">
      <span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? 'bg-ok-bg text-ok' : 'bg-soft text-muted'}`}>{done ? '✓' : '•'}</span>
      <span className={done ? 'font-semibold' : 'text-ink2'}>{text}</span>
    </li>
  );
}

/** One thing to check: the books' figure, what was found, and whether they agree. */
function CheckRow(p: {
  title: string;
  booksLabel: string;
  books: string;
  inputLabel: string;
  submitted: Submitted | null;
  submittedValue: string | undefined;
  stale: boolean;
  editable: boolean;
  draft: Draft;
  diff: bigint | null;
  onDraft: (patch: Partial<Draft>) => void;
  onOpen: (fileId: string) => void;
}) {
  const { t } = useTranslation();
  const result = (diff: bigint): ReactNode =>
    diff === 0n ? (
      <span className="rounded-full bg-ok-bg px-2.5 py-0.5 text-xs font-semibold text-ok">✓ {t('reconcile.matched')}</span>
    ) : (
      <span className="rounded-full bg-bad-bg px-2.5 py-0.5 text-xs font-semibold text-bad">{t('reconcile.mismatch', { amount: `${diff > 0n ? '+' : '−'}${taka(diff > 0n ? diff : -diff)}` })}</span>
    );
  const shownDiff = p.submitted ? BigInt(p.submitted.difference_paisa) : null;
  return (
    <li className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold">{p.title}</span>
        {p.submitted && !p.stale && result(shownDiff!)}
        {p.stale && <span className="rounded-full bg-bad-bg px-2.5 py-0.5 text-xs font-semibold text-bad">{t('reconcile.booksChanged')}</span>}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-soft p-2.5">
          <dt className="text-xs text-muted">{p.booksLabel}</dt>
          <dd className="font-bold tabular-nums">{taka(p.books)}</dd>
        </div>
        <div className="rounded-xl bg-soft p-2.5">
          <dt className="text-xs text-muted">{p.inputLabel}</dt>
          <dd className="font-bold tabular-nums">{p.submittedValue ? taka(p.submittedValue) : '—'}</dd>
        </div>
      </dl>
      {p.submitted?.note && <p className="mt-2 text-sm text-ink2">{p.submitted.note}</p>}
      {p.submitted?.proof_file_id && (
        <button type="button" onClick={() => p.onOpen(p.submitted!.proof_file_id!)} className="mt-2 inline-flex items-center gap-1 rounded-full bg-soft px-2.5 py-1 text-xs font-semibold text-ink2 hover:bg-hover">
          <Icon d={ICONS.doc} size={14} />{t('reconcile.viewStatement')}
        </button>
      )}
      {p.editable && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <label className="field-label">
            {p.submitted ? t('reconcile.newFigure') : p.inputLabel}
            <input className="field mt-1 w-full" inputMode="decimal" value={p.draft.amount} onChange={(e) => p.onDraft({ amount: e.target.value })} />
          </label>
          {p.diff !== null && result(p.diff)}
          {p.diff !== null && p.diff !== 0n && (
            <label className="field-label">
              {t('reconcile.whyDifferent')}
              <input className="field mt-1 w-full" value={p.draft.note} onChange={(e) => p.onDraft({ note: e.target.value })} />
            </label>
          )}
          <div className="field-label">
            {t('reconcile.statementPhoto')}<Optional />
            <FilePicker className="mt-1 font-normal" file={p.draft.file} onChange={(file) => p.onDraft({ file })} />
          </div>
        </div>
      )}
    </li>
  );
}
