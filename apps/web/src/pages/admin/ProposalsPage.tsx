import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PROPOSAL_STATUSES, PROPOSAL_TYPES, COMPLIANCE_CHECKLIST_FIELDS, type ProposalType } from '@barakah/shared';
import {
  AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, ICONS, InfoRow, MemberBadge, SplitLayout, StatGrid, StatTile,
} from '../../components/admin';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { Icon } from '../../components/ui';
import { StatusPill } from '../../components/StatusPill';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCountdown } from '../../lib/countdown';
import { fmtInstant } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { parseAmountInput, taka } from '../../lib/money';
import type { ProposalDetail } from '../../lib/types';
import { FORM_TYPES, ProposalFields, buildPayload, emptyForm, type FormState } from './proposalForms';

const CREATE_TYPES: ProposalType[] = FORM_TYPES;

interface ProposalListRow {
  id: string;
  type: ProposalType;
  title: string;
  status: string;
  basis: 'member' | 'share';
  eligible_count: number;
  eligible_weight: string;
  threshold: number;
  threshold_weight: string;
  counts: { yes: number; no: number; abstain: number; yes_weight: string; no_weight: string; abstain_weight: string };
  ballots_hidden: boolean;
  voted_count?: number;
  can_close_early?: boolean;
  subject_member_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  amount_paisa: string | null;
}

export function ProposalsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<ProposalType>('general');
  const panel = useRef<HTMLDivElement>(null);

  const privileged = me?.roles.some((r) => r === 'cashier' || r === 'auditor') ?? false;

  const list = (status: string, type: string) => ({
    queryKey: ['proposals', 'admin', status, type],
    queryFn: () =>
      api<{ items: ProposalListRow[]; next_cursor: string | null }>(`/proposals?limit=200${status ? `&status=${status}` : ''}${type ? `&type=${type}` : ''}`),
  });
  const proposals = useQuery(list(statusFilter, typeFilter));
  // the tiles count everything, whatever the list below is filtered to (same cache entry when unfiltered)
  const everything = useQuery(list('', ''));
  const all = everything.data?.items ?? [];
  const count = (status: string) => (everything.data ? formatCount(all.filter((p) => p.status === status).length) : null);

  const rows = proposals.data?.items ?? [];
  const selected = rows.find((p) => p.id === selectedId) ?? rows[0] ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['proposals'] });
    void qc.invalidateQueries({ queryKey: ['proposal'] });
  };
  const choose = (id: string) => {
    setSelectedId(id);
    if (!window.matchMedia('(min-width: 1280px)').matches) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const toggleStatus = (status: string) => setStatusFilter((s) => (s === status ? '' : status));

  return (
    <AdminPage>
      <AdminHeader
        title={t('proposalsPage.title')}
        subtitle={t('adminUi.sub.proposals')}
        actions={
          <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
            <Icon d={ICONS.plus} size={18} sw={2} />
            {t('proposalsPage.newProposal')}
          </button>
        }
      />

      <StatGrid>
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.vote} label={t('adminUi.proposals.statOpen')} value={count('open')} pressed={statusFilter === 'open'} onClick={() => toggleStatus('open')} />
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.check} label={t('adminUi.proposals.statToExecute')} value={count('approved')} pressed={statusFilter === 'approved'} onClick={() => toggleStatus('approved')} />
        <StatTile tone="bg-soft text-ink2" icon={ICONS.doc} label={t('adminUi.proposals.statDraft')} value={count('draft')} pressed={statusFilter === 'draft'} onClick={() => toggleStatus('draft')} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.layers} label={t('adminUi.proposals.statTotal')} value={everything.data ? formatCount(all.length) : null} pressed={!statusFilter && !typeFilter} onClick={() => { setStatusFilter(''); setTypeFilter(''); }} />
      </StatGrid>

      <SplitLayout
        sideWidth="400px"
        main={
          <Card className="px-5 pb-3 pt-5 sm:px-6">
            <CardHead
              title={t('proposalsPage.title')}
              sub={proposals.data ? t('proposalsPage.count', { count: rows.length }) : undefined}
              action={
                <>
                  <select aria-label={t('common.status')} className="field" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="">{t('common.status')}: {t('common.all')}</option>
                    {PROPOSAL_STATUSES.map((st) => (
                      <option key={st} value={st}>{t(`status.proposal.${st}`)}</option>
                    ))}
                  </select>
                  <select aria-label={t('proposalsPage.type')} className="field" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">{t('proposalsPage.type')}: {t('common.all')}</option>
                    {PROPOSAL_TYPES.map((ty) => (
                      <option key={ty} value={ty}>{t(`proposalType.${ty}`)}</option>
                    ))}
                  </select>
                </>
              }
            />
            {proposals.error ? (
              <LoadError error={proposals.error} onRetry={() => void proposals.refetch()} />
            ) : !proposals.data ? (
              <ListSkeleton rows={4} />
            ) : rows.length === 0 ? (
              <EmptyCard text={t('proposalsPage.empty')} icon={ICONS.vote} />
            ) : (
              <ul>
                {rows.map((p) => (
                  <ProposalItem key={p.id} p={p} privileged={privileged} selected={selected?.id === p.id} onSelect={() => choose(p.id)} onRefresh={refresh} />
                ))}
              </ul>
            )}
          </Card>
        }
        side={
          <div ref={panel} className="scroll-mt-4">
            <ProposalPanel id={selected?.id ?? null} loading={!proposals.data} />
          </div>
        }
      />

      <AdminDialog open={createOpen} onClose={() => setCreateOpen(false)} title={t('proposalsPage.newProposal')} wide>
        <CreateProposalForm type={createType} onTypeChange={setCreateType} onCreated={() => { setCreateOpen(false); refresh(); }} onCancel={() => setCreateOpen(false)} />
      </AdminDialog>
    </AdminPage>
  );
}

const STATUS_DOT: Record<string, string> = {
  draft: 'bg-muted',
  open: 'bg-warn',
  approved: 'bg-primary',
  executed: 'bg-ok',
  rejected: 'bg-bad',
  lapsed: 'bg-muted',
  cancelled: 'bg-muted',
};

function ProposalItem({
  p,
  privileged,
  selected,
  onSelect,
  onRefresh,
}: {
  p: ProposalListRow;
  privileged: boolean;
  selected: boolean;
  onSelect: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const remaining = useCountdown(p.closes_at);
  const tally = p.ballots_hidden
    ? t('votes.needToPass', { need: p.basis === 'share' ? p.threshold_weight : p.threshold })
    : p.basis === 'share' ? `${p.counts.yes_weight}/${p.threshold_weight}` : `${p.counts.yes}/${p.threshold}`;

  return (
    <li
      data-testid="proposal-row"
      aria-current={selected}
      className={`-mx-2 rounded-xl border-b border-border px-2 py-3 transition-colors last:border-b-0 ${selected ? 'bg-primary-soft' : 'hover:bg-hover'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button type="button" className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onSelect}>
          <span aria-hidden="true" className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[p.status] ?? 'bg-muted'}`} />
          <span className="min-w-0">
            <span className="block font-semibold">{p.title}</span>
            <span className="block text-xs text-muted">
              {t(`proposalType.${p.type}`)} · {t('proposalsPage.created', { date: fmtInstant(p.created_at) })}
            </span>
          </span>
        </button>
        <StatusPill status={p.status === 'open' ? 'pending' : p.status} label={t(`status.proposal.${p.status}`)} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-[1.375rem] text-[0.8125rem] text-ink2">
        <span>{t('proposal.threshold')}: <b className="tabular-nums">{tally}</b></span>
        {p.voted_count !== undefined && (
          <span data-testid="turnout">{t('proposal.turnout', { voted: p.voted_count, total: p.eligible_count })}</span>
        )}
        {p.closes_at && <span>{t('votes.deadline')}: {remaining ?? fmtInstant(p.closes_at)}</span>}
        {p.amount_paisa && <span>{t('common.amount')}: <b className="tabular-nums">{taka(p.amount_paisa)}</b></span>}
      </div>

      {privileged && (p.status === 'draft' || p.status === 'open' || p.status === 'approved') && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[1.375rem]">
          {p.status === 'draft' && <OpenButton id={p.id} onDone={onRefresh} />}
          {p.status === 'draft' && <CancelButton id={p.id} onDone={onRefresh} />}
          {p.status === 'open' && <CloseEarlyButton id={p.id} onDone={onRefresh} canClose={p.can_close_early === true} />}
          {p.status === 'approved' && <ExecuteButton id={p.id} type={p.type} onDone={onRefresh} />}
        </div>
      )}
    </li>
  );
}

function OpenButton({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [closesAt, setClosesAt] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 72, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });

  return (
    <>
      <button type="button" className={BTN_SM_PRIMARY} onClick={() => setOpen(true)}>
        {t('proposal.open')}
      </button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.openTitle')}
        confirmLabel={t('proposal.open')}
        onConfirm={async () => {
          await api(`/proposals/${id}/open`, { method: 'POST', body: { closes_at: new Date(closesAt).toISOString() } });
          setOpen(false);
          onDone();
        }}
      >
        <p className="text-muted">{t('proposal.openBody')}</p>
        <label className="block text-sm text-muted">
          {t('proposal.closesAt')}
          <input type="datetime-local" className="field mt-1 w-full" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </label>
      </ConfirmSheet>
    </>
  );
}

function CloseEarlyButton({ id, onDone, canClose }: { id: string; onDone: () => void; canClose: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!canClose}
        title={canClose ? undefined : t('proposal.closeEarlyDisabled')}
        className={BTN_SM}
        onClick={() => setOpen(true)}
      >
        {t('proposal.closeEarly')}
      </button>
      {!canClose && <p className="basis-full text-xs text-muted">{t('proposal.closeEarlyDisabled')}</p>}
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.closeEarlyTitle')}
        confirmLabel={t('proposal.closeEarly')}
        tone="danger"
        onConfirm={async () => {
          await api(`/proposals/${id}/close-early`, { method: 'POST' });
          setOpen(false);
          onDone();
        }}
      >
        <p className="text-muted">{t('proposal.closeEarlyBody')}</p>
      </ConfirmSheet>
    </>
  );
}

function CancelButton({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={BTN_SM} onClick={() => setOpen(true)}>
        {t('common.cancel')}
      </button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.cancelTitle')}
        confirmLabel={t('common.cancel')}
        tone="danger"
        onConfirm={async () => {
          await api(`/proposals/${id}/cancel`, { method: 'POST' });
          setOpen(false);
          onDone();
        }}
      >
        <p className="text-muted">{t('proposal.cancelBody')}</p>
      </ConfirmSheet>
    </>
  );
}

function ExecuteButton({ id, type, onDone }: { id: string; type: ProposalType; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isCharity = type === 'charity_donation';
  // These executors post the amount actually paid or received, to or from the chosen account.
  const needsAmount = isCharity || type === 'expense' || type === 'investment_purchase' || type === 'asset_sale';
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<'CASH' | 'BANK' | 'BKASH' | 'NAGAD'>('CASH');

  return (
    <>
      <button type="button" data-testid="execute-proposal" className={BTN_SM_PRIMARY} onClick={() => setOpen(true)}>
        {t('proposal.execute')}
      </button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.executeTitle')}
        confirmLabel={t('proposal.execute')}
        canConfirm={!needsAmount || parseAmountInput(amount) !== null}
        onConfirm={async () => {
          const body: Record<string, unknown> = {};
          if (needsAmount) {
            const paisa = parseAmountInput(amount);
            if (!paisa) throw new ApiError(400, 'request.invalid', 'Amount required');
            body.actual_amount_paisa = paisa;
            body.account = account;
          }
          await api(`/proposals/${id}/execute`, { method: 'POST', body });
          setOpen(false);
          onDone();
        }}
      >
        <p className="text-muted">{t('proposal.executeBody')}</p>
        {needsAmount && (
          <>
            <label className="block text-sm text-muted">
              {t(isCharity ? 'common.amount' : 'proposal.executeAmount')}
              <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="block text-sm text-muted">
              {isCharity ? t('payment.method') : t(type === 'asset_sale' ? 'proposal.executeAccountIn' : 'proposal.executeAccount')}
              <select className="field mt-1 w-full" value={account} onChange={(e) => setAccount(e.target.value as typeof account)}>
                <option value="CASH">{t('payment.methods.cash')}</option>
                <option value="BANK">{t('payment.methods.bank')}</option>
                <option value="BKASH">{t('payment.methods.bkash')}</option>
                <option value="NAGAD">{t('payment.methods.nagad')}</option>
              </select>
            </label>
          </>
        )}
      </ConfirmSheet>
    </>
  );
}

export function CreateProposalForm({
  type,
  onTypeChange,
  onCreated,
  onCancel,
  initialValues,
  lockType = false,
}: {
  type: ProposalType;
  onTypeChange: (t: ProposalType) => void;
  onCreated: () => void;
  onCancel: () => void;
  /** Fields filled in before the user types anything (the gold page starts a purchase as gold). */
  initialValues?: Record<string, string>;
  /** Hide the type chooser: the caller already decided what is being proposed. */
  lockType?: boolean;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [clauseRef, setClauseRef] = useState('');
  const fresh = (): FormState => ({ ...emptyForm(), values: { ...initialValues } });
  const [form, setForm] = useState<FormState>(fresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const changeType = (next: ProposalType) => {
    setForm(fresh());
    setError(null);
    onTypeChange(next);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { payload, subject } = await buildPayload(type, form);
      await api('/proposals', {
        method: 'POST',
        body: {
          type,
          title: title.trim() || t(`proposalType.${type}`),
          payload,
          ...(subject ? { subject_member_id: subject } : {}),
          ...(clauseRef.trim() ? { clause_ref: clauseRef.trim() } : {}),
        },
      });
      setTitle('');
      setClauseRef('');
      setForm(fresh());
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {!lockType && <label className="block text-sm text-muted">
          {t('proposalsPage.type')}
          <select className="field mt-1 w-full" value={type} onChange={(e) => changeType(e.target.value as ProposalType)}>
            {CREATE_TYPES.map((s) => (
              <option key={s} value={s}>{t(`proposalType.${s}`)}</option>
            ))}
          </select>
        </label>}
        <label className="block text-sm text-muted">
          {t('proposal.clauseRef')}
          <input className="field mt-1 w-full" value={clauseRef} onChange={(e) => setClauseRef(e.target.value)} />
        </label>
      </div>
      <label className="block text-sm text-muted">
        {t('proposal.title')}
        <input className="field mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <ProposalFields type={type} form={form} onChange={setForm} />
      {error != null && <p role="alert" className="rounded-xl bg-bad-bg px-3 py-2 text-sm text-bad">{proposalErrorText(error, t)}</p>}
      <div className="flex gap-2.5 pt-1">
        <button type="submit" disabled={busy} className={`${BTN_PRIMARY} flex-1`}>{busy ? t('common.working') : t('common.submit')}</button>
        <button type="button" className={`${BTN_SECONDARY} flex-1`} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/** The chosen proposal in full: what it does, the checklist, and who has voted. */
function ProposalPanel({ id, loading }: { id: string | null; loading: boolean }) {
  const { t } = useTranslation();
  const proposal = useQuery({ queryKey: ['proposal', id], enabled: !!id, queryFn: () => api<ProposalDetail>(`/proposals/${id}`) });
  const d = proposal.data;

  if (!id) {
    return <Card className="p-5">{loading ? <Skeleton className="h-64 w-full" /> : <EmptyCard text={t('proposalsPage.empty')} icon={ICONS.vote} />}</Card>;
  }
  if (proposal.error) return <Card className="p-5"><LoadError error={proposal.error} onRetry={() => void proposal.refetch()} /></Card>;
  if (!d) return <Card className="p-5"><Skeleton className="h-64 w-full" /></Card>;

  const voted = d.voters.filter((v) => d.votes.some((vote) => vote.member_id === v.member_id)).length;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-bold leading-snug">{d.title}</h2>
        <StatusPill status={d.status === 'open' ? 'pending' : d.status} label={t(`status.proposal.${d.status}`)} />
      </div>
      <p className="mt-0.5 text-[0.8125rem] text-muted">{t(`proposalType.${d.type}`)}</p>
      {d.description && <p className="mt-3 text-sm">{d.description}</p>}

      <dl className="mt-3">
        {d.subject && <InfoRow label={t('proposal.subject')} value={`${d.subject.code} ${d.subject.full_name}`} />}
        {d.clause_ref && <InfoRow label={t('proposal.clauseRef')} value={d.clause_ref} />}
        <InfoRow
          label={t('proposal.threshold')}
          value={d.ballots_hidden ? t('votes.hiddenUntilClose') : d.basis === 'share' ? `${d.counts.yes_weight}/${d.threshold_weight}` : `${d.counts.yes}/${d.threshold}`}
        />
      </dl>
      {d.voted_count !== undefined && <p className="mt-2 text-sm font-semibold">{t('proposal.turnout', { voted: d.voted_count, total: d.eligible_count })}</p>}

      <div className="mt-3 space-y-3 text-sm">
        <ComplianceChecklist type={d.type} payload={d.payload} />
        <PayloadPreview payload={d.payload} />
      </div>

      <div className="mb-1 mt-4 flex items-center justify-between">
        <h3 className="text-sm font-bold">{t('proposal.voterList')}</h3>
        {!d.ballots_hidden && <span className="text-xs text-muted tabular-nums">{formatCount(voted)}/{formatCount(d.voters.length)}</span>}
      </div>
      <ul className="max-h-80 overflow-y-auto text-sm">
        {d.voters.map((v) => {
          const cast = d.votes.find((vote) => vote.member_id === v.member_id);
          return (
            <li key={v.member_id} className="flex items-center justify-between gap-2 border-t border-border py-2">
              <span className="flex min-w-0 items-center gap-2">
                <MemberBadge code={v.code} />
                <span className="truncate">{v.full_name}{d.basis === 'share' && <span className="text-muted"> · {v.weight}</span>}</span>
              </span>
              {!d.ballots_hidden && (
                <span className={`shrink-0 text-xs font-semibold ${cast ? (cast.choice === 'yes' ? 'text-ok' : cast.choice === 'no' ? 'text-bad' : 'text-ink2') : 'text-muted'}`}>
                  {cast ? t(`votes.${cast.choice}`) : t('votes.notVoted')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ComplianceChecklist({ type, payload }: { type: ProposalType; payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (type !== 'investment_purchase') return null;
  const compliance = (payload.compliance ?? {}) as Record<string, boolean>;
  const allTrue = COMPLIANCE_CHECKLIST_FIELDS.every((f) => compliance[f] === true);
  return (
    <div className={`rounded-xl p-3 ${allTrue ? 'bg-ok-bg' : 'bg-warn-bg'}`}>
      <p className="mb-1 font-medium">{t('proposalsPage.compliance')}</p>
      <ul className="space-y-1">
        {COMPLIANCE_CHECKLIST_FIELDS.map((f) => (
          <li key={f} className="flex items-center gap-2">
            <span className={compliance[f] ? 'text-ok' : 'text-bad'}>{compliance[f] ? '✓' : '✗'}</span>
            <span>{t(`compliance.${f}`)}</span>
          </li>
        ))}
      </ul>
      {!allTrue && <p className="mt-2 text-bad">{t('proposalsPage.complianceIncomplete')}</p>}
    </div>
  );
}

function PayloadPreview({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  const entries = Object.entries(payload).filter(([k, v]) => v !== undefined && v !== null && k !== 'compliance');
  if (entries.length === 0) return null;
  return (
    <div className="rounded-xl bg-soft p-3">
      <p className="mb-1 font-medium">{t('proposal.payload')}</p>
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[9rem_1fr] gap-2 py-1">
          <span className="text-muted">{t(`proposalFields.${k}`, { defaultValue: k })}</span>
          <span className="break-words">
            {k.toLowerCase().includes('amount') || k.toLowerCase().includes('paisa') ? taka(String(v)) : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? t('common.yes') : t('common.no')) : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}


/** The message under the new-proposal form; for a rejected payload it names the fields that are wrong. */
function proposalErrorText(error: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!(error instanceof ApiError)) return t('errors.generic');
  if (error.code === 'request.invalid') return `${t('proposalFields.missing')}: ${t(`proposalFields.${error.message}`, { defaultValue: error.message })}`;
  if (error.code === 'proposal.invalid_payload') {
    const issues = (error.extra['errors'] ?? []) as Array<{ path?: Array<string | number> }>;
    const fields = [...new Set(issues.map((i) => String(i.path?.[0] ?? '')).filter(Boolean))];
    const names = fields.map((f) => t(`proposalFields.${f}`, { defaultValue: f })).join(', ');
    const phoneHint = fields.includes('phone') ? ` ${t('proposalFields.phoneHint')}` : '';
    return `${t('proposalFields.invalidFields')}: ${names}.${phoneHint}`;
  }
  return t(`errors.${error.code}`, { defaultValue: t('errors.generic') });
}
