import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PROPOSAL_TYPES, type ProposalType } from '@barakah/shared';
import {
  AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, BTN_SM, BTN_SM_PRIMARY, Card, EmptyCard, ICONS, MemberBadge, Segmented, SplitLayout,
} from '../../components/admin';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { Icon, Optional } from '../../components/ui';
import { ProposalDetails } from '../../components/ProposalDetails';
import { AmountLine, PillWithTimeLeft, TurnoutDots, VoteMeter, voteTally, writtenKey, writtenText } from '../../components/ProposalCardParts';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatCount } from '../../lib/format';
import { ClauseLink, ClauseSelect, usePolicyClause } from '../../components/ClauseSelect';
import { parseAmountInput } from '../../lib/money';
import { useMediaQuery } from '../../lib/useMediaQuery';
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
  /** Who has voted, never what; sent to the cashier and the auditor, empty for a draft. */
  voters?: Array<{ code: string; full_name: string; voted: boolean }>;
  can_close_early?: boolean;
  subject_member_id: string | null;
  opens_at: string | null;
  closes_at: string | null;
  created_at: string;
  amount_paisa: string | null;
  payload: Record<string, unknown>;
}

/**
 * The status tabs above the list. The page opens on `active` (running votes and drafts, owner);
 * `closed` gathers every vote that ended without being carried out.
 */
const TABS = ['active', 'approved', 'draft', 'executed', 'closed', 'all'] as const;
type Tab = (typeof TABS)[number];
const inTab = (status: string, tab: Tab) => {
  if (tab === 'all') return true;
  if (tab === 'active') return status === 'open' || status === 'draft';
  if (tab === 'closed') return status === 'rejected' || status === 'lapsed' || status === 'cancelled';
  return status === tab;
};

export function ProposalsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  // `?new=<type>` (from the charity & levy page) opens the new-proposal form on that type;
  // `?id=<proposal>` (from a shop withdrawal) opens that proposal.
  const [params, setParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  // A linked proposal may have ended already, so such a link starts on the tab that has everything.
  const [tab, setTab] = useState<Tab>(() => (params.get('id') ? 'all' : 'active'));
  const asked = params.get('new');
  const preset = asked && (CREATE_TYPES as readonly string[]).includes(asked) ? (asked as ProposalType) : null;
  const [createOpen, setCreateOpen] = useState(preset !== null);
  const [createType, setCreateType] = useState<ProposalType>(preset ?? 'general');
  const closeCreate = () => {
    setCreateOpen(false);
    if (asked) setParams({}, { replace: true });
  };
  // From `xl` the details sit beside the list; below that they slide in over it, only when asked for.
  const wide = useMediaQuery('(min-width: 1280px)');

  const privileged = me?.roles.some((r) => r === 'cashier' || r === 'auditor') ?? false;

  const proposals = useQuery({
    queryKey: ['proposals', 'admin', typeFilter],
    queryFn: () => api<{ items: ProposalListRow[]; next_cursor: string | null }>(`/proposals?limit=200${typeFilter ? `&type=${typeFilter}` : ''}`),
  });

  const all = proposals.data?.items ?? [];
  const needle = search.trim().toLowerCase();
  const rows = all
    .filter((p) => inTab(p.status, tab) && (!needle || p.title.toLowerCase().includes(needle)))
    // Running votes come before drafts; otherwise the server's order stays.
    .sort((a, b) => (tab === 'active' ? Number(b.status === 'open') - Number(a.status === 'open') : 0));
  const selected = rows.find((p) => p.id === selectedId) ?? rows[0] ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['proposals'] });
    void qc.invalidateQueries({ queryKey: ['proposal'] });
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

      <div className="space-y-3">
        <Segmented
          label={t('common.status')}
          value={tab}
          onChange={setTab}
          options={TABS.map((value) => ({
            value,
            label: t(`proposalsPage.tabs.${value}`),
            count: proposals.data ? formatCount(all.filter((p) => inTab(p.status, value)).length) : undefined,
          }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-56 sm:max-w-sm">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon d={ICONS.search} size={18} /></span>
            <input type="search" aria-label={t('proposalsPage.search')} placeholder={t('proposalsPage.search')} className="field w-full pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select aria-label={t('proposalsPage.type')} className="field max-w-full basis-full sm:basis-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">{t('proposalsPage.type')}: {t('common.all')}</option>
            {PROPOSAL_TYPES.map((ty) => (
              <option key={ty} value={ty}>{t(`proposalType.${ty}`)}</option>
            ))}
          </select>
        </div>
      </div>

      <SplitLayout
        sideWidth="400px"
        main={
          proposals.error ? (
            <Card className="p-5"><LoadError error={proposals.error} onRetry={() => void proposals.refetch()} /></Card>
          ) : !proposals.data ? (
            <Card className="p-5"><ListSkeleton rows={4} /></Card>
          ) : rows.length === 0 ? (
            <Card className="p-5"><EmptyCard text={t(all.length === 0 && !typeFilter ? 'proposalsPage.empty' : tab === 'active' && !needle ? 'proposalsPage.noActive' : 'proposalsPage.noMatch')} icon={ICONS.vote} /></Card>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
              {rows.map((p) => (
                <ProposalItem key={p.id} p={p} privileged={privileged} selected={wide && selected?.id === p.id} onSelect={() => setSelectedId(p.id)} onRefresh={refresh} />
              ))}
            </ul>
          )
        }
        side={wide ? <ProposalPanel id={selected?.id ?? null} loading={!proposals.data} /> : undefined}
      />

      {!wide && (
        <ProposalDrawer id={selectedId} onClose={() => setSelectedId(null)} privileged={privileged} onRefresh={refresh} />
      )}

      <AdminDialog open={createOpen} onClose={closeCreate} title={t('proposalsPage.newProposal')} wide>
        <CreateProposalForm type={createType} onTypeChange={setCreateType} onCreated={() => { closeCreate(); refresh(); }} onCancel={closeCreate} />
      </AdminDialog>
    </AdminPage>
  );
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
  const tally = voteTally(p, t);
  const written = writtenText(p.payload);
  const showActions = privileged && hasActions(p.status);
  const voters = p.voters ?? [];

  // The title button's hit area is stretched over the whole card (its ::after), so a tap anywhere
  // opens it; the action buttons sit above that layer.
  return (
    <li
      data-testid="proposal-row"
      aria-current={selected}
      className={`relative flex min-w-0 flex-col gap-3 rounded-lg border p-4 shadow-card transition-all sm:p-5 ${selected ? 'border-track bg-soft shadow-lift' : 'border-border bg-card hover:border-track hover:shadow-lift'}`}
    >
      {/* The title is the first thing on the card (owner); the pill drops under it when there is no room. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <button type="button" className="block rounded-md text-left text-base font-bold leading-snug outline-none [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring" onClick={onSelect}>
            {p.title}
          </button>
          {written && <p className="line-clamp-2 text-meta text-muted [overflow-wrap:anywhere]">{written}</p>}
        </div>
        <PillWithTimeLeft status={p.status} closesAt={p.closes_at} />
      </div>

      {p.amount_paisa && <AmountLine paisa={p.amount_paisa} />}

      {tally.counted && tally.yes !== null && <VoteMeter tally={tally} status={p.status} />}

      {(showActions || voters.length > 0) && (
        <div className={`mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 ${showActions ? 'border-t border-border pt-3' : ''}`}>
          {showActions && (
            <div className="relative z-10 flex flex-wrap items-center gap-2">
              <ProposalActions p={p} onDone={onRefresh} />
            </div>
          )}
          {voters.length > 0 && <TurnoutDots voters={voters} />}
        </div>
      )}
    </li>
  );
}

const hasActions = (status: string) => status === 'draft' || status === 'open' || status === 'approved' || status === 'rejected';

/** What the cashier and the auditor can do next, by status: the same buttons on a card and in the drawer. */
function ProposalActions({ p, onDone }: { p: Pick<ProposalListRow, 'id' | 'type' | 'status' | 'can_close_early'>; onDone: () => void }) {
  return (
    <>
      {p.status === 'draft' && <OpenButton id={p.id} onDone={onDone} />}
      {p.status === 'draft' && <CancelButton id={p.id} onDone={onDone} />}
      {p.status === 'open' && <CloseEarlyButton id={p.id} onDone={onDone} canClose={p.can_close_early === true} />}
      {p.status === 'open' && <CancelButton id={p.id} running onDone={onDone} />}
      {p.status === 'approved' && <ExecuteButton id={p.id} type={p.type} onDone={onDone} />}
      {(p.status === 'approved' || p.status === 'rejected') && <ReopenButton id={p.id} onDone={onDone} />}
    </>
  );
}

/** Phone and tablet: the chosen proposal slides in from the right, over the list. */
function ProposalDrawer({ id, onClose, privileged, onRefresh }: { id: string | null; onClose: () => void; privileged: boolean; onRefresh: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background pt-[env(safe-area-inset-top)] shadow-lift sm:w-[28rem]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-sm font-bold">{t('proposalsPage.selected')}</Dialog.Title>
            <Dialog.Close aria-label={t('common.close')} className="grid h-11 w-11 place-items-center rounded-md text-muted transition-colors hover:bg-hover">
              <Icon d="M6 6l12 12M18 6L6 18" size={18} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <ProposalPanel id={id} loading={false} actions={privileged} onRefresh={onRefresh} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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

/** Open a finished, not yet executed vote again with a new close time and a reason (kept in the audit log). */
function ReopenButton({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [closesAt, setClosesAt] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 72, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  return (
    <>
      <button type="button" className={BTN_SM} onClick={() => setOpen(true)}>
        {t('proposal.reopen')}
      </button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.reopenTitle')}
        confirmLabel={t('proposal.reopen')}
        canConfirm={reason.trim().length >= 3}
        onConfirm={async () => {
          await api(`/proposals/${id}/reopen`, { method: 'POST', body: { closes_at: new Date(closesAt).toISOString(), reason: reason.trim() } });
          setOpen(false);
          setReason('');
          onDone();
        }}
      >
        <p className="text-muted">{t('proposal.reopenBody')}</p>
        <label className="field-label">
          {t('proposal.closesAt')}
          <input type="datetime-local" className="field mt-1 w-full" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </label>
        <label className="field-label">
          {t('proposal.reopenReason')}
          <textarea className="field mt-1 min-h-20 w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </ConfirmSheet>
    </>
  );
}

function CloseEarlyButton({ id, onDone, canClose }: { id: string; onDone: () => void; canClose: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  return (
    <>
      {/* A disabled button takes no hover or tap, so the wrapper does: it shows why (tap or Tab on a phone or keyboard). */}
      <span className="group relative inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={canClose ? undefined : 0}>
        <button
          type="button"
          disabled={!canClose}
          aria-describedby={canClose ? undefined : reasonId}
          className={`${BTN_SM} disabled:pointer-events-none`}
          onClick={() => setOpen(true)}
        >
          {t('proposal.closeEarly')}
        </button>
        {!canClose && (
          <span
            id={reasonId}
            role="tooltip"
            className="invisible absolute bottom-full left-0 z-20 mb-2 w-max max-w-[16rem] rounded-md border border-track bg-card px-3 py-2 text-xs text-ink2 opacity-0 shadow-lift transition-opacity group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100"
          >
            {t('proposal.closeEarlyDisabled')}
          </span>
        )}
      </span>
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
  defaultTitle,
  hide,
}: {
  type: ProposalType;
  onTypeChange: (t: ProposalType) => void;
  onCreated: () => void;
  onCancel: () => void;
  /** Fields filled in before the user types anything (the gold page starts a purchase as gold). */
  initialValues?: Record<string, string>;
  /**
   * Hide the type chooser: the caller already decided what is being proposed. The fields it filled in
   * (`initialValues`) are hidden too, and the form asks what is left first, the clause and title last.
   */
  lockType?: boolean;
  /** The title used when none is typed (the type's name otherwise). */
  defaultTitle?: string;
  /** With `lockType`: which filled-in fields to hide, when some are only suggestions (all of them otherwise). */
  hide?: readonly string[];
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [clauseRef, setClauseRef] = useState('');
  const policyClause = usePolicyClause(type);
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
          title: title.trim() || defaultTitle || t(`proposalType.${type}`),
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

  const titleField = (
    <label className="field-label">
      {t('proposal.title')}
      <Optional />
      <input className="field mt-1 w-full" value={title} placeholder={defaultTitle || t(`proposalType.${type}`)} onChange={(e) => setTitle(e.target.value)} />
    </label>
  );

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!lockType && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            {t('proposalsPage.type')}
            <select className="field mt-1 w-full" value={type} onChange={(e) => changeType(e.target.value as ProposalType)}>
              {CREATE_TYPES.map((s) => (
                <option key={s} value={s}>{t(`proposalType.${s}`)}</option>
              ))}
            </select>
          </label>
          <ClauseSelect value={clauseRef} onChange={setClauseRef} suggested={policyClause} />
        </div>
      )}
      {!lockType && titleField}
      <ProposalFields type={type} form={form} onChange={setForm} hidden={lockType ? (hide ?? Object.keys(initialValues ?? {})) : []} />
      {lockType && <ClauseSelect value={clauseRef} onChange={setClauseRef} suggested={policyClause} />}
      {lockType && titleField}
      {error != null && <p role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad">{proposalErrorText(error, t)}</p>}
      <div className="flex gap-2.5 pt-1">
        <button type="submit" disabled={busy} className={`${BTN_PRIMARY} flex-1`}>{busy ? t('common.working') : t('common.submit')}</button>
        <button type="button" className={`${BTN_SECONDARY} flex-1`} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/** The chosen proposal in full: what it does, the checklist, and who has voted. */
function ProposalPanel({ id, loading, actions = false, onRefresh }: { id: string | null; loading: boolean; actions?: boolean; onRefresh?: () => void }) {
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
  const textKey = writtenKey(d.payload);
  const written = writtenText(d.payload);
  // The headline amount is not repeated in the details; a "maximum amount" row stays, for its label.
  const omit = [textKey, d.amount_paisa && d.payload.amount_paisa === d.amount_paisa ? 'amount_paisa' : undefined].filter((k): k is string => !!k);
  const lead: Array<[string, ReactNode]> = [[t('proposalsPage.typeRow'), t(`proposalType.${d.type}`)]];
  if (d.subject) lead.push([t('proposal.subject'), `${d.subject.code} ${d.subject.full_name}`]);
  if (d.clause_ref) lead.push([t('proposal.clauseRef'), <ClauseLink clause={d.clause_ref} />]);

  // Laid out like the card in the list (owner): title, amount and vote bar, then one section per subject.
  return (
    <Card className="divide-y divide-border">
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-48 space-y-1">
            <h2 className="text-base font-bold leading-snug [overflow-wrap:anywhere]">{d.title}</h2>
            {written && <p className="whitespace-pre-line text-meta text-muted [overflow-wrap:anywhere]">{written}</p>}
          </div>
          <PillWithTimeLeft status={d.status} closesAt={d.closes_at} />
        </div>
        {d.description && d.description !== written && <p className="text-sm [overflow-wrap:anywhere]">{d.description}</p>}
        {d.amount_paisa && <AmountLine paisa={d.amount_paisa} />}
        {tally.counted && <VoteMeter tally={tally} status={d.status} voted={d.voted_count} eligible={d.eligible_count} showNeed />}
        {actions && onRefresh && hasActions(d.status) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <ProposalActions p={d} onDone={onRefresh} />
          </div>
        )}
      </div>

      <section className="p-4 sm:p-5">
        <h3 className="mb-1 text-sm font-bold">{t('proposal.payload')}</h3>
        <ProposalDetails type={d.type} payload={d.payload} table={{ lead, omit }} />
      </section>

      <section className="p-4 sm:p-5">
        <div className="mb-2 flex items-center justify-between gap-3">
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
                {/* While the vote is open only whether they voted is shown, never their choice; the dot is the card's. */}
                <span className={`flex shrink-0 items-center gap-1.5 text-xs font-semibold ${v.voted ? 'text-ink2' : 'text-muted'}`}>
                  <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full border-[1.5px] ${v.voted ? 'border-ok bg-ok' : 'border-bad'}`} />
                  {!d.ballots_hidden && cast ? t(`votes.${cast.choice}`) : v.voted ? t('proposal.votedYes') : t('proposal.votedNo')}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </Card>
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
