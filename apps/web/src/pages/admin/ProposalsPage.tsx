import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
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
import { fmtDate, fmtInstant } from '../../lib/dates';
import { formatCount, localDigits } from '../../lib/format';
import { parseAmountInput, taka } from '../../lib/money';
import type { MemberRow, ProposalDetail } from '../../lib/types';
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
  // `?new=<type>` (from the charity & levy page) opens the new-proposal form on that type;
  // `?id=<proposal>` (from a shop withdrawal) opens that proposal.
  const [params, setParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const asked = params.get('new');
  const preset = asked && (CREATE_TYPES as readonly string[]).includes(asked) ? (asked as ProposalType) : null;
  const [createOpen, setCreateOpen] = useState(preset !== null);
  const [createType, setCreateType] = useState<ProposalType>(preset ?? 'general');
  const closeCreate = () => {
    setCreateOpen(false);
    if (asked) setParams({}, { replace: true });
  };
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
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.vote} label={t('adminUi.proposals.statOpen')} value={count('open')} />
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.check} label={t('adminUi.proposals.statToExecute')} value={count('approved')} />
        <StatTile tone="bg-soft text-ink2" icon={ICONS.doc} label={t('adminUi.proposals.statDraft')} value={count('draft')} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.layers} label={t('adminUi.proposals.statTotal')} value={everything.data ? formatCount(all.length) : null} />
      </StatGrid>

      <SplitLayout
        sideWidth="400px"
        main={
          <Card className="px-5 pb-0 pt-5 sm:px-6">
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

      <AdminDialog open={createOpen} onClose={closeCreate} title={t('proposalsPage.newProposal')} wide>
        <CreateProposalForm type={createType} onTypeChange={setCreateType} onCreated={() => { closeCreate(); refresh(); }} onCancel={closeCreate} />
      </AdminDialog>
    </AdminPage>
  );
}

/**
 * "হ্যাঁ ভোট: ৫ · পাস করতে লাগবে ৪" instead of "5/4": the yes count so far (null while ballots are
 * hidden), what the proposal needs, and whether it has reached it. Share-weighted votes count shares.
 */
/**
 * Yes votes and the pass mark, always with their unit: a share-weighted vote needs e.g. "9 shares (of 16)",
 * which read as a bare "9" looks like more people than the fund has.
 */
function voteTally(
  p: Pick<ProposalListRow, 'status' | 'ballots_hidden' | 'basis' | 'counts' | 'threshold' | 'threshold_weight' | 'eligible_count' | 'eligible_weight'>,
  t: TFunction,
): { counted: boolean; yes: string | null; need: string; passed: boolean } {
  const byShare = p.basis === 'share';
  const yes = byShare ? String(p.counts.yes_weight) : String(p.counts.yes);
  const need = byShare ? String(p.threshold_weight) : String(p.threshold);
  const total = byShare ? String(p.eligible_weight) : String(p.eligible_count);
  // A draft (or one cancelled before opening) has no voters and a pass mark of 0, so 0 >= 0 must not read as passed.
  const counted = p.status !== 'draft' && BigInt(need) > 0n;
  return {
    counted,
    yes: p.ballots_hidden ? null : t(byShare ? 'proposal.countShares' : 'proposal.countMembers', { n: localDigits(yes) }),
    need: t(byShare ? 'proposal.needShares' : 'proposal.needMembers', { n: localDigits(need), total: localDigits(total) }),
    passed: counted && !p.ballots_hidden && BigInt(yes) >= BigInt(need),
  };
}

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
  const tally = voteTally(p, t);

  // Rows run edge to edge of the card; the chosen one carries the same green mark as the detail
  // panel beside it, so the two read as one. The title button's hit area is stretched over the whole
  // row (its ::after), so a tap anywhere opens it; the action buttons sit above that layer.
  return (
    <li
      data-testid="proposal-row"
      aria-current={selected}
      className={`relative -mx-5 cursor-pointer border-b border-border px-5 py-4 transition-colors last:border-b-0 sm:-mx-6 sm:px-6 ${selected ? 'bg-primary-soft' : 'hover:bg-hover'}`}
    >
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />}
      <div className="flex items-start gap-3">
        <button type="button" className="min-w-0 flex-1 rounded-lg text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring" onClick={onSelect}>
          <span className="block font-semibold leading-snug">{p.title}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {t(`proposalType.${p.type}`)} · {t('proposalsPage.created', { date: fmtInstant(p.created_at) })}
          </span>
        </button>
        <StatusPill status={p.status === 'open' ? 'pending' : p.status} label={t(`status.proposal.${p.status}`)} />
        {/* points at the detail panel, which sits beside the list on wide screens */}
        <span aria-hidden="true" className={`mt-1 hidden shrink-0 xl:block ${selected ? 'text-primary' : 'text-muted'}`}><Icon d="M9 6l6 6-6 6" size={18} sw={2} /></span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[0.8125rem]">
        {tally.counted && tally.yes !== null && <div className="flex gap-1.5"><dt className="text-muted">{t('proposal.yesVotes')}</dt><dd className="font-semibold tabular-nums">{tally.yes}</dd></div>}
        {tally.counted && <div className="flex gap-1.5"><dt className="text-muted">{t('proposal.needToPass')}</dt><dd className="font-semibold tabular-nums">{tally.need}</dd></div>}
        {tally.passed && <div className="font-semibold text-ok">✓ {t('proposal.passed')}</div>}
        {tally.counted && p.voted_count !== undefined && (
          <div data-testid="turnout" className="flex gap-1.5">
            <dt className="text-muted">{t('proposalsPage.voted')}</dt>
            <dd className="font-semibold tabular-nums">{formatCount(p.voted_count)}/{formatCount(p.eligible_count)}</dd>
          </div>
        )}
        {p.closes_at && p.status === 'open' && <div className="flex gap-1.5"><dt className="text-muted">{t('votes.deadline')}</dt><dd className="font-semibold">{remaining ?? fmtInstant(p.closes_at)}</dd></div>}
        {p.amount_paisa && <div className="flex gap-1.5"><dt className="text-muted">{t('common.amount')}</dt><dd className="font-semibold tabular-nums">{taka(p.amount_paisa)}</dd></div>}
      </dl>

      {privileged && (p.status === 'draft' || p.status === 'open' || p.status === 'approved') && (
        <div className="relative z-10 mt-3 flex flex-wrap items-center gap-2">
          {p.status === 'draft' && <OpenButton id={p.id} onDone={onRefresh} />}
          {p.status === 'draft' && <CancelButton id={p.id} onDone={onRefresh} />}
          {p.status === 'open' && <CloseEarlyButton id={p.id} onDone={onRefresh} canClose={p.can_close_early === true} />}
          {p.status === 'open' && <CancelButton id={p.id} running onDone={onRefresh} />}
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
        <label className="field-label">
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

/** Pushes a reminder to everyone who has not voted yet; the server sends each member at most one a day. */
function RemindButton({ id, count }: { id: string; count: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  return (
    <div className="mb-2">
      <button type="button" className={BTN_SM} onClick={() => setOpen(true)}>
        <Icon d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" size={16} />
        {t('proposal.remind')}
      </button>
      {done !== null && (
        <p role="status" className="mt-1.5 text-xs text-ok">
          {done > 0 ? t('proposal.remindDone', { n: formatCount(done) }) : t('proposal.remindNone')}
        </p>
      )}
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.remindTitle')}
        confirmLabel={t('proposal.remindSend')}
        onConfirm={async () => {
          const res = await api<{ reminded: number }>(`/proposals/${id}/remind`, { method: 'POST' });
          setDone(res.reminded);
          setOpen(false);
        }}
      >
        <p className="text-muted">{t('proposal.remindBody', { n: formatCount(count) })}</p>
      </ConfirmSheet>
    </div>
  );
}

/** Cancel a draft, or stop a running vote (which needs a reason, kept in the audit log). */
function CancelButton({ id, running = false, onDone }: { id: string; running?: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonOk = reason.trim().length >= 3;
  return (
    <>
      <button type="button" className={BTN_SM} onClick={() => setOpen(true)}>
        {t('common.cancel')}
      </button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t(running ? 'proposal.cancelOpenTitle' : 'proposal.cancelTitle')}
        confirmLabel={t('common.cancel')}
        tone="danger"
        canConfirm={!running || reasonOk}
        onConfirm={async () => {
          await api(`/proposals/${id}/cancel`, { method: 'POST', body: running ? { reason: reason.trim() } : {} });
          setOpen(false);
          onDone();
        }}
      >
        <p className="text-muted">{t(running ? 'proposal.cancelOpenBody' : 'proposal.cancelBody')}</p>
        {running && (
          <label className="field-label">
            {t('proposal.cancelReason')}
            <textarea className="field mt-1 min-h-20 w-full" value={reason} placeholder={t('proposal.cancelReasonHint')} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
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
            <label className="field-label">
              {t(isCharity ? 'common.amount' : 'proposal.executeAmount')}
              <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="field-label">
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
        {!lockType && <label className="field-label">
          {t('proposalsPage.type')}
          <select className="field mt-1 w-full" value={type} onChange={(e) => changeType(e.target.value as ProposalType)}>
            {CREATE_TYPES.map((s) => (
              <option key={s} value={s}>{t(`proposalType.${s}`)}</option>
            ))}
          </select>
        </label>}
        <label className="field-label">
          {t('proposal.clauseRef')}
          <input className="field mt-1 w-full" value={clauseRef} onChange={(e) => setClauseRef(e.target.value)} />
        </label>
      </div>
      <label className="field-label">
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

  const voted = d.voters.filter((v) => v.voted).length;
  const tally = voteTally(d, t);
  return (
    <Card>
      {/* The green bar and "selected proposal" tie this panel to the marked row in the list. */}
      <div aria-hidden="true" className="h-1 bg-primary" />
      <header className="border-b border-border px-5 pb-4 pt-4">
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Icon d="M15 6l-6 6 6 6" size={14} sw={2.2} />
          {t('proposalsPage.selected')}
        </p>
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 text-lg font-bold leading-snug [overflow-wrap:anywhere]">{d.title}</h2>
          <StatusPill status={d.status === 'open' ? 'pending' : d.status} label={t(`status.proposal.${d.status}`)} />
        </div>
        <p className="mt-0.5 text-[0.8125rem] text-muted">{t(`proposalType.${d.type}`)}</p>
      </header>

      <div className="p-5">
      {d.description && <p className="mb-3 text-sm [overflow-wrap:anywhere]">{d.description}</p>}

      <dl>
        {d.subject && <InfoRow label={t('proposal.subject')} value={`${d.subject.code} ${d.subject.full_name}`} />}
        {d.clause_ref && <InfoRow label={t('proposal.clauseRef')} value={d.clause_ref} />}
        {tally.counted && <InfoRow label={t('proposal.yesVotes')} value={tally.yes ?? t('votes.hiddenUntilClose')} />}
        {tally.counted && (
          <InfoRow
            label={t('proposal.needToPass')}
            value={tally.passed ? <>{tally.need} <span className="ml-1 text-ok">✓ {t('proposal.passed')}</span></> : tally.need}
          />
        )}
        {tally.counted && d.voted_count !== undefined && <InfoRow label={t('proposalsPage.voted')} value={`${formatCount(d.voted_count)}/${formatCount(d.eligible_count)}`} />}
      </dl>

      <div className="mt-3 space-y-3 text-sm">
        <ComplianceChecklist type={d.type} payload={d.payload} />
        <PayloadPreview payload={d.payload} />
      </div>

      <div className="mb-1 mt-4 flex items-center justify-between">
        <h3 className="text-sm font-bold">{t('proposal.voterList')}</h3>
        <span className="text-xs text-muted tabular-nums">{formatCount(voted)}/{formatCount(d.voters.length)}</span>
      </div>
      {d.status === 'open' && d.voted_count !== undefined && voted < d.voters.length && (
        <RemindButton id={d.id} count={d.voters.length - voted} />
      )}
      <ul className="max-h-80 overflow-y-auto text-sm">
        {d.voters.map((v) => {
          const cast = d.votes.find((vote) => vote.member_id === v.member_id);
          return (
            <li key={v.member_id} className="flex items-center justify-between gap-2 border-t border-border py-2">
              <span className="flex min-w-0 items-center gap-2">
                <MemberBadge code={v.code} />
                <span className="truncate">{v.full_name}{d.basis === 'share' && <span className="text-muted"> · {v.weight}</span>}</span>
              </span>
              {/* While the vote is open only whether they voted is shown (green/red dot), never their choice. */}
              <span className={`flex shrink-0 items-center gap-1.5 text-xs font-semibold ${v.voted ? 'text-ok' : 'text-bad'}`}>
                <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${v.voted ? 'bg-ok' : 'bg-bad'}`} />
                {!d.ballots_hidden && cast ? t(`votes.${cast.choice}`) : v.voted ? t('proposal.votedYes') : t('proposal.votedNo')}
              </span>
            </li>
          );
        })}
      </ul>
      </div>
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The proposal's own details in words: member ids become names, dates and amounts are formatted, a
 * plan (a list of instalments) becomes one line per instalment. Nothing is shown as raw JSON.
 */
function PayloadPreview({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const entries = Object.entries(payload).filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'compliance');
  if (entries.length === 0) return null;

  const label = (k: string) => t(`proposalFields.${k}`, { defaultValue: k.replace(/_/g, ' ') });
  const value = (k: string, v: unknown): ReactNode => {
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (typeof v === 'number') return formatCount(v);
    if (Array.isArray(v)) {
      return (
        <ul className="space-y-1">
          {v.map((item, i) => (
            <li key={i} className="tabular-nums">
              {item && typeof item === 'object' ? Object.entries(item as Record<string, unknown>).map(([ik, iv]) => value(ik, iv)).filter(Boolean).reduce<ReactNode[]>((acc, part, j) => (j ? [...acc, ' · ', part] : [part]), []) : value(k, item)}
            </li>
          ))}
        </ul>
      );
    }
    if (typeof v === 'object' && v) {
      return Object.entries(v as Record<string, unknown>).map(([ik, iv]) => <span key={ik} className="block">{label(ik)}: {value(ik, iv)}</span>);
    }
    const text = String(v);
    if (/amount|paisa/i.test(k)) return taka(text);
    if (UUID.test(text)) {
      const m = members.data?.items.find((x) => x.id === text);
      return m ? `${m.code} ${m.full_name}` : '…';
    }
    if (DAY.test(text)) return fmtDate(text);
    if (k === 'kind') return t(`settlementKind.${text}`, { defaultValue: text });
    return text;
  };

  return (
    <div className="rounded-xl bg-soft p-3">
      <p className="mb-1 font-medium">{t('proposal.payload')}</p>
      <dl>
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-3 border-t border-border py-2 first:border-t-0">
            <dt className="text-muted">{label(k)}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{value(k, v)}</dd>
          </div>
        ))}
      </dl>
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
