import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { SETTLEMENT_KINDS } from '@barakah/shared';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtInstant, todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { parseAmountInput, taka } from '../../lib/money';
import type { ContactLogItem, MemberRow, MemberStatusEvent } from '../../lib/types';

export function MembersAdminPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const isCashier = me?.roles.includes('cashier') ?? false;

  const [active, setActive] = useState<{ kind: 'status' | 'suspension' | 'reinstatement' | 'settlement' | 'contact' | 'pin'; member: MemberRow } | null>(null);

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">{t('membersAdmin.title')}</h1>

      {members.error ? (
        <LoadError error={members.error} onRetry={() => void members.refetch()} />
      ) : !members.data ? (
        <ListSkeleton rows={6} />
      ) : members.data.items.length === 0 ? (
        <Empty text={t('common.noData')} />
      ) : (
        <div className="overflow-x-auto rounded-[18px] border border-border bg-card shadow-card">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead className="text-muted">
              <tr>
                <th className="p-2 text-left">{t('membersPage.register')}</th>
                <th className="p-2 text-left">{t('membersPage.shares')}</th>
                <th className="p-2 text-left">{t('membersPage.capital')}</th>
                <th className="p-2 text-left">{t('membersPage.outstanding')}</th>
                <th className="p-2 text-left">{t('membersAdmin.currentPeriodDue')}</th>
                <th className="p-2 text-left">{t('common.status')}</th>
                <th className="p-2 text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.data.items.map((m) => (
                <tr key={m.id} className="hover:bg-hover">
                  <td className="p-2 whitespace-nowrap">{m.code} · {m.full_name}</td>
                  <td className="p-2">{formatCount(m.shares)}</td>
                  <td className="p-2">{taka(m.capital_paisa)}</td>
                  <td className="p-2">{taka(BigInt(m.outstanding_principal_paisa) + BigInt(m.outstanding_fines_paisa))}</td>
                  <td className="p-2">
                    {m.current_period_status ? (
                      <StatusPill status={m.current_period_status} />
                    ) : (
                      <span className="text-muted">{t('common.none')}</span>
                    )}
                  </td>
                  <td className="p-2">{t(`status.member.${m.status}`, { defaultValue: m.status })}</td>
                  <td className="p-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <ActionButton onClick={() => setActive({ kind: 'status', member: m })}>{t('membersAdmin.statusHistory')}</ActionButton>
                      {isCashier && (m.status === 'active' || m.status === 'warning') && <ActionButton onClick={() => setActive({ kind: 'suspension', member: m })}>{t('membersAdmin.createSuspension')}</ActionButton>}
                      {isCashier && m.status === 'suspended' && <ActionButton onClick={() => setActive({ kind: 'reinstatement', member: m })}>{t('membersAdmin.reinstate')}</ActionButton>}
                      {isCashier && (m.status === 'active' || m.status === 'warning' || m.status === 'suspended') && <ActionButton onClick={() => setActive({ kind: 'settlement', member: m })}>{t('membersAdmin.settlement')}</ActionButton>}
                      {isCashier && <ActionButton onClick={() => setActive({ kind: 'pin', member: m })}>{t('membersAdmin.issuePin')}</ActionButton>}
                      <ActionButton onClick={() => setActive({ kind: 'contact', member: m })}>{t('membersAdmin.addContactLog')}</ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <>
          <StatusHistoryDialog member={active.member} open={active.kind === 'status'} onClose={() => setActive(null)} />
          <SuspensionDialog member={active.member} open={active.kind === 'suspension'} onClose={() => setActive(null)} />
          <IssuePinDialog member={active.member} open={active.kind === 'pin'} onClose={() => setActive(null)} />
          <ReinstatementDialog member={active.member} open={active.kind === 'reinstatement'} onClose={() => setActive(null)} />
          <SettlementDialog member={active.member} open={active.kind === 'settlement'} onClose={() => setActive(null)} />
          <ContactLogDialog member={active.member} open={active.kind === 'contact'} onClose={() => setActive(null)} isCashier={isCashier} />
        </>
      )}
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="h-9 rounded-xl border border-border px-2 text-xs hover:bg-hover">
      {children}
    </button>
  );
}

function StatusHistoryDialog({ member, open, onClose }: { member: MemberRow; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['status-history', member.id],
    enabled: open,
    queryFn: () => api<{ items: MemberStatusEvent[] }>(`/members/${member.id}/status-history`),
  });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('membersAdmin.statusHistory')} — {member.code} {member.full_name}</Dialog.Title>
          {q.error ? <LoadError error={q.error} /> : !q.data ? <ListSkeleton rows={4} /> : q.data.items.length === 0 ? <Empty text={t('common.noData')} /> : (
            <ul className="divide-y divide-border text-sm">
              {q.data.items.map((e) => (
                <li key={e.id} className="py-2">
                  <div className="flex justify-between">
                    <span className="font-medium">{e.from_status ?? t('membersAdmin.noPrior')} → {e.to_status}</span>
                    <span className="text-muted">{fmtInstant(e.created_at)}</span>
                  </div>
                  {e.reason && <p className="text-muted">{t('common.reason')}: {e.reason}</p>}
                </li>
              ))}
            </ul>
          )}
          <Dialog.Close className="mt-4 h-11 w-full rounded-xl border border-border">{t('common.close')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SuspensionDialog({ member, open, onClose }: { member: MemberRow; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [clause, setClause] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!reason.trim()) throw new ApiError(400, 'request.invalid', 'Reason required');
      await api('/proposals', {
        method: 'POST',
        body: {
          type: 'suspension',
          title: `${t('proposalType.suspension')}: ${member.code} ${member.full_name}`,
          subject_member_id: member.id,
          description: reason.trim(),
          payload: { member_id: member.id, reason: reason.trim(), ...(clause ? { clause_ref: clause } : {}) },
          ...(clause ? { clause_ref: clause } : {}),
        },
      });
      setReason('');
      setClause('');
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('membersAdmin.createSuspension')}</Dialog.Title>
          <p className="mb-3 text-muted">{member.code} {member.full_name}</p>
          <label className="block text-sm text-muted">
            {t('common.reason')}
            <textarea className="mt-1 min-h-20 w-full rounded-md border border-input bg-background p-2" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="mt-2 block text-sm text-muted">
            {t('proposal.clauseRef')}
            <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={clause} onChange={(e) => setClause(e.target.value)} />
          </label>
          {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void submit()} className="h-11 flex-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50">{busy ? t('common.working') : t('common.submit')}</button>
            <Dialog.Close className="h-11 flex-1 rounded-xl border border-border">{t('common.cancel')}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function IssuePinDialog({ member, open, onClose }: { member: MemberRow; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const close = () => {
    setPin(null);
    setError(null);
    onClose();
  };

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setPin((await api<{ pin: string }>(`/members/${member.id}/pin`, { method: 'POST' })).pin);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('membersAdmin.issuePin')}</Dialog.Title>
          <p className="mb-1 text-muted">{member.code} {member.full_name}</p>
          {pin === null ? (
            <>
              <p className="mb-3 text-sm text-muted">{t('membersAdmin.issuePinHint')}</p>
              {error != null && <p className="mb-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void issue()} className="h-11 flex-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50">{busy ? t('common.working') : t('membersAdmin.issuePin')}</button>
                <Dialog.Close className="h-11 flex-1 rounded-xl border border-border">{t('common.cancel')}</Dialog.Close>
              </div>
            </>
          ) : (
            <>
              <p className="my-4 select-all text-center font-mono text-4xl tracking-[0.3em]" data-testid="issued-pin">{pin}</p>
              <p className="mb-3 text-sm text-muted">{t('membersAdmin.issuePinOnce')}</p>
              <button type="button" onClick={close} className="h-11 w-full rounded-xl border border-border">{t('common.close')}</button>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ReinstatementDialog({ member, open, onClose }: { member: MemberRow; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [terms, setTerms] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/proposals', {
        method: 'POST',
        body: {
          type: 'reinstatement',
          title: `${t('proposalType.reinstatement')}: ${member.code} ${member.full_name}`,
          subject_member_id: member.id,
          ...(terms.trim() ? { description: terms.trim() } : {}),
          payload: { member_id: member.id, ...(terms.trim() ? { terms: terms.trim() } : {}) },
        },
      });
      setTerms('');
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('membersAdmin.reinstate')}</Dialog.Title>
          <p className="mb-1 text-muted">{member.code} {member.full_name}</p>
          <p className="mb-3 text-sm text-muted">{t('membersAdmin.reinstateHint')}</p>
          <label className="block text-sm text-muted">
            {t('proposal.terms')}
            <textarea className="mt-1 min-h-20 w-full rounded-md border border-input bg-background p-2" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </label>
          {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void submit()} className="h-11 flex-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50">{busy ? t('common.working') : t('common.submit')}</button>
            <Dialog.Close className="h-11 flex-1 rounded-xl border border-border">{t('common.cancel')}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettlementDialog({ member, open, onClose }: { member: MemberRow; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [kind, setKind] = useState<string>('early_exit');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(todayDhaka());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const paisa = parseAmountInput(amount);
      if (!paisa) throw new ApiError(400, 'request.invalid', t('pay.invalidAmount'));
      const payload = {
        member_id: member.id,
        kind,
        payout_plan: [{ due_on: dueDate, amount_paisa: paisa }],
      };
      await api('/proposals', {
        method: 'POST',
        body: {
          type: 'settlement',
          title: `${t('proposalType.settlement')}: ${member.code} ${member.full_name}`,
          subject_member_id: member.id,
          description: `Settlement proposal for ${member.code}.`,
          payload,
        },
      });
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('membersAdmin.settlement')}</Dialog.Title>
          <p className="mb-3 text-muted">{member.code} {member.full_name}</p>
          <label className="block text-sm text-muted">
            {t('membersAdmin.settlementKind')}
            <select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={kind} onChange={(e) => setKind(e.target.value)}>
              {SETTLEMENT_KINDS.map((k) => (
                <option key={k} value={k}>{t(`settlementKind.${k}`)}</option>
              ))}
            </select>
          </label>
          <label className="mt-2 block text-sm text-muted">
            {t('membersAdmin.settlementNetAmount')}
            <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="mt-2 block text-sm text-muted">
            {t('membersAdmin.settlementDueDate')}
            <input type="date" className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void submit()} className="h-11 flex-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50">{busy ? t('common.working') : t('common.submit')}</button>
            <Dialog.Close className="h-11 flex-1 rounded-xl border border-border">{t('common.cancel')}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ContactLogDialog({ member, open, onClose, isCashier }: { member: MemberRow; open: boolean; onClose: () => void; isCashier: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['contact-log', member.id],
    enabled: open,
    queryFn: () => api<{ items: ContactLogItem[] }>(`/members/${member.id}/contact-log`),
  });

  const [kind, setKind] = useState<string>('call');
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/members/${member.id}/contact-log`, { method: 'POST', body: { kind, outcome: outcome || undefined, note: note || undefined } });
      void qc.invalidateQueries({ queryKey: ['contact-log', member.id] });
      setOutcome('');
      setNote('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const reinstate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/members/${member.id}/reinstate`, { method: 'POST' });
      void qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('membersAdmin.contactLogTitle')} — {member.code} {member.full_name}</Dialog.Title>

          {isCashier && member.status === 'suspended' && (
            <div className="mb-3 rounded-xl bg-primary-soft p-2">
              <button type="button" disabled={busy} onClick={() => void reinstate()} className="h-10 w-full rounded-xl bg-primary px-3 text-primary-foreground disabled:opacity-50">
                {busy ? t('common.working') : t('membersAdmin.reinstate')}
              </button>
              <p className="mt-1 text-xs text-muted">{t('membersAdmin.reinstateHint')}</p>
            </div>
          )}

          {isCashier && (
            <div className="mb-3 space-y-2 rounded-xl border border-border p-2">
              <label className="block text-sm text-muted">
                {t('membersAdmin.contactKind')}
                <select className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {['call', 'message', 'email', 'registered_letter', 'visit'].map((k) => (
                    <option key={k} value={k}>{t(`contactKind.${k}`)}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-muted">
                {t('membersAdmin.contactOutcome')}
                <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
              </label>
              <label className="block text-sm text-muted">
                {t('common.note')}
                <textarea className="mt-1 min-h-16 w-full rounded-md border border-input bg-background p-2" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="button" disabled={busy} onClick={() => void submit()} className="h-10 rounded-xl bg-primary px-3 text-primary-foreground disabled:opacity-50">
                {busy ? t('common.working') : t('membersAdmin.addContactLog')}
              </button>
            </div>
          )}

          {error != null && <p className="mb-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}

          {q.error ? <LoadError error={q.error} /> : !q.data ? <ListSkeleton rows={3} /> : q.data.items.length === 0 ? <Empty text={t('membersAdmin.noContactLog')} /> : (
            <ul className="divide-y divide-border text-sm">
              {q.data.items.map((e) => (
                <li key={e.id} className="py-2">
                  <div className="flex justify-between">
                    <span className="font-medium">{t(`contactKind.${e.kind}`)}</span>
                    <span className="text-muted">{fmtInstant(e.at)}</span>
                  </div>
                  {e.outcome && <p className="text-muted">{t('membersAdmin.contactOutcome')}: {e.outcome}</p>}
                  {e.note && <p className="text-muted">{e.note}</p>}
                </li>
              ))}
            </ul>
          )}
          <Dialog.Close className="mt-4 h-11 w-full rounded-xl border border-border">{t('common.close')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
