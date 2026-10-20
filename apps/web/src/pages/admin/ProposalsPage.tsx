import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { PROPOSAL_STATUSES, PROPOSAL_TYPES, COMPLIANCE_CHECKLIST_FIELDS, type ProposalType } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useCountdown } from '../../lib/countdown';
import { fmtInstant } from '../../lib/dates';
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createType, setCreateType] = useState<ProposalType>('general');

  const privileged = me?.roles.some((r) => r === 'cashier' || r === 'auditor') ?? false;

  const proposals = useQuery<{ items: ProposalListRow[]; next_cursor: string | null }>({
    queryKey: ['proposals', 'admin', statusFilter, typeFilter],
    queryFn: () =>
      api<{ items: ProposalListRow[]; next_cursor: string | null }>(
        `/proposals?limit=200${statusFilter ? `&status=${statusFilter}` : ''}${typeFilter ? `&type=${typeFilter}` : ''}`,
      ),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['proposals'] });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('proposalsPage.title')}</h1>
        <span className="text-sm text-muted">{t('proposalsPage.count', { count: proposals.data?.items.length ?? 0 })}</span>
      </div>

      <CreateProposalForm type={createType} onTypeChange={setCreateType} onCreated={refresh} />

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-muted">
          {t('common.status')}
          <select className="ml-2 h-11 rounded-md border border-input bg-background px-2" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {PROPOSAL_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`status.proposal.${s}`)}</option>
            ))}
          </select>
        </label>
        <label className="text-sm text-muted">
          {t('proposalsPage.type')}
          <select className="ml-2 h-11 rounded-md border border-input bg-background px-2" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {PROPOSAL_TYPES.map((s) => (
              <option key={s} value={s}>{t(`proposalType.${s}`)}</option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
      </div>

      {proposals.error ? (
        <LoadError error={proposals.error} onRetry={() => void proposals.refetch()} />
      ) : !proposals.data ? (
        <ListSkeleton rows={4} />
      ) : proposals.data.items.length === 0 ? (
        <Empty text={t('proposalsPage.empty')} />
      ) : (
        <ul className="space-y-2">
          {proposals.data.items.map((p) => (
            <ProposalItem key={p.id} p={p} privileged={privileged} onOpenDetail={() => setDetailId(p.id)} onRefresh={refresh} />
          ))}
        </ul>
      )}

      <ProposalDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function ProposalItem({
  p,
  privileged,
  onOpenDetail,
  onRefresh,
}: {
  p: ProposalListRow;
  privileged: boolean;
  onOpenDetail: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const remaining = useCountdown(p.closes_at);

  return (
    <li data-testid="proposal-row" className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button type="button" className="text-left font-semibold hover:text-primary" onClick={onOpenDetail}>
            {p.title}
          </button>
          <p className="text-sm text-muted">
            {t(`proposalType.${p.type}`)} · {t('proposalsPage.created', { date: fmtInstant(p.created_at) })}
          </p>
        </div>
        <span className="shrink-0">
          <StatusPill status={p.status === 'open' ? 'pending' : p.status} label={t(`status.proposal.${p.status}`)} />
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-4 text-sm">
        <span>
          {t('proposal.threshold')}: {p.basis === 'share' ? `${p.counts.yes_weight}/${p.threshold_weight}` : `${p.counts.yes}/${p.threshold}`}
        </span>
        <span>
          {t('votes.deadline')}: {p.closes_at ? (remaining ?? fmtInstant(p.closes_at)) : t('common.none')}
        </span>
        {p.amount_paisa && <span>{t('common.amount')}: {taka(p.amount_paisa)}</span>}
      </div>

      {privileged && (
        <div className="mt-3 flex flex-wrap gap-2">
          {p.status === 'draft' && <OpenButton id={p.id} onDone={onRefresh} />}
          {p.status === 'draft' && <CancelButton id={p.id} onDone={onRefresh} />}
          {p.status === 'open' && <CloseEarlyButton id={p.id} onDone={onRefresh} />}
          {p.status === 'approved' && <ExecuteButton id={p.id} type={p.type} onDone={onRefresh} />}
          <button type="button" className="h-10 rounded-md border border-border px-3" onClick={onOpenDetail}>
            {t('common.details')}
          </button>
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
      <button type="button" className="h-10 rounded-md bg-primary px-3 text-primary-foreground" onClick={() => setOpen(true)}>
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
          <input type="datetime-local" className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </label>
      </ConfirmSheet>
    </>
  );
}

function CloseEarlyButton({ id, onDone }: { id: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="h-10 rounded-md border border-border px-3" onClick={() => setOpen(true)}>
        {t('proposal.closeEarly')}
      </button>
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
      <button type="button" className="h-10 rounded-md border border-border px-3" onClick={() => setOpen(true)}>
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
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<'CASH' | 'BANK' | 'BKASH' | 'NAGAD'>('CASH');

  return (
    <>
      <button type="button" data-testid="execute-proposal" className="h-10 rounded-md bg-primary px-3 text-primary-foreground" onClick={() => setOpen(true)}>
        {t('proposal.execute')}
      </button>
      <ConfirmSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('proposal.executeTitle')}
        confirmLabel={t('proposal.execute')}
        canConfirm={!isCharity || parseAmountInput(amount) !== null}
        onConfirm={async () => {
          const body: Record<string, unknown> = {};
          if (isCharity) {
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
        {isCharity && (
          <>
            <label className="block text-sm text-muted">
              {t('common.amount')}
              <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="block text-sm text-muted">
              {t('payment.method')}
              <select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={account} onChange={(e) => setAccount(e.target.value as typeof account)}>
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

function CreateProposalForm({
  type,
  onTypeChange,
  onCreated,
}: {
  type: ProposalType;
  onTypeChange: (t: ProposalType) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [clauseRef, setClauseRef] = useState('');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const changeType = (next: ProposalType) => {
    setForm(emptyForm());
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
      setForm(emptyForm());
      setExpanded(false);
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      {!expanded ? (
        <button type="button" className="h-10 rounded-md bg-primary px-3 text-primary-foreground" onClick={() => setExpanded(true)}>
          {t('proposalsPage.newProposal')}
        </button>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h3 className="font-semibold">{t('proposalsPage.newProposal')}</h3>
          <label className="block text-sm text-muted">
            {t('proposalsPage.type')}
            <select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={type} onChange={(e) => changeType(e.target.value as ProposalType)}>
              {CREATE_TYPES.map((s) => (
                <option key={s} value={s}>{t(`proposalType.${s}`)}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-muted">
            {t('proposal.title')}
            <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <ProposalFields type={type} form={form} onChange={setForm} />
          <label className="block text-sm text-muted">
            {t('proposal.clauseRef')}
            <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={clauseRef} onChange={(e) => setClauseRef(e.target.value)} />
          </label>
          {error != null && <p className="text-bad">{error instanceof ApiError && error.code === 'request.invalid' ? `${t('proposalFields.missing')}: ${t(`proposalFields.${error.message}`, { defaultValue: error.message })}` : error instanceof ApiError ? t(`errors.${error.code}`, { defaultValue: t('errors.generic') }) : t('errors.generic')}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="h-10 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">{busy ? t('common.working') : t('common.submit')}</button>
            <button type="button" className="h-10 rounded-md border border-border px-3" onClick={() => setExpanded(false)}>{t('common.cancel')}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function ProposalDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const proposal = useQuery({ queryKey: ['proposal', id], enabled: !!id, queryFn: () => api<ProposalDetail>(`/proposals/${id}`) });

  return (
    <Dialog.Root open={!!id} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(36rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          {!proposal.data ? (
            <Dialog.Title className="text-lg font-semibold"><div className="h-7 w-48 animate-pulse rounded bg-muted" /></Dialog.Title>
          ) : (
            <>
              <Dialog.Title className="text-lg font-semibold">{proposal.data.title}</Dialog.Title>
              <div className="mt-2 space-y-3 text-sm">
                {proposal.data.description && <p>{proposal.data.description}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <SheetRow label={t('common.status')} value={<StatusPill status={proposal.data.status === 'open' ? 'pending' : proposal.data.status} label={t(`status.proposal.${proposal.data.status}`)} />} />
                  <SheetRow label={t('proposalsPage.type')} value={t(`proposalType.${proposal.data.type}`)} />
                  {proposal.data.subject && <SheetRow label={t('proposal.subject')} value={`${proposal.data.subject.code} ${proposal.data.subject.full_name}`} />}
                  {proposal.data.clause_ref && <SheetRow label={t('proposal.clauseRef')} value={proposal.data.clause_ref} />}
                  <SheetRow label={t('proposal.threshold')} value={proposal.data.basis === 'share' ? `${proposal.data.counts.yes_weight}/${proposal.data.threshold_weight}` : `${proposal.data.counts.yes}/${proposal.data.threshold}`} />
                </div>
                <ComplianceChecklist type={proposal.data.type} payload={proposal.data.payload} />
                <PayloadPreview payload={proposal.data.payload} />
                <h4 className="font-semibold">{t('proposal.voterList')}</h4>
                <ul className="divide-y divide-border">
                  {proposal.data.voters.map((v) => {
                    const cast = proposal.data!.votes.find((vote) => vote.member_id === v.member_id);
                    return (
                      <li key={v.member_id} className="flex justify-between py-1">
                        <span>{v.code} {v.full_name}{proposal.data!.basis === 'share' && <span className="text-muted"> · {v.weight}</span>}</span>
                        <span className="font-medium">{cast ? t(`votes.${cast.choice}`) : <span className="text-muted">{t('votes.notVoted')}</span>}</span>
                      </li>
                    );
                  })}
                </ul>
                <Dialog.Close className="mt-2 h-11 w-full rounded-md border border-border">{t('common.close')}</Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ComplianceChecklist({ type, payload }: { type: ProposalType; payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (type !== 'investment_purchase') return null;
  const compliance = (payload.compliance ?? {}) as Record<string, boolean>;
  const allTrue = COMPLIANCE_CHECKLIST_FIELDS.every((f) => compliance[f] === true);
  return (
    <div className={`rounded-md border p-3 ${allTrue ? 'border-ok/30 bg-ok/10' : 'border-warn/30 bg-warn/10'}`}>
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
    <div className="rounded-md border border-border p-3">
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

