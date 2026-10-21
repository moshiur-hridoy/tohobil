import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { SETTLEMENT_KINDS } from '@barakah/shared';
import {
  AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, Card, EmptyCard, ICONS, InfoRow, MemberBadge, Segmented, SplitLayout, StatGrid, StatTile,
} from '../../components/admin';
import { ListSkeleton, Skeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { Icon } from '../../components/ui';
import { StatusPill } from '../../components/StatusPill';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtInstant, todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { arrearsOf, parseAmountInput, taka } from '../../lib/money';
import type { ContactLogItem, MemberRow, MemberStatusEvent } from '../../lib/types';

type Kind = 'status' | 'suspension' | 'reinstatement' | 'settlement' | 'contact' | 'pin';
type Filter = 'all' | 'active' | 'arrears' | 'suspended';

const STATUS_TONE: Record<string, string> = {
  active: 'bg-ok-bg text-ok',
  warning: 'bg-warn-bg text-warn',
  suspended: 'bg-bad-bg text-bad',
};

const isActive = (m: MemberRow) => m.status === 'active' || m.status === 'warning';

const inFilter = (m: MemberRow, f: Filter): boolean =>
  f === 'all' || (f === 'active' ? isActive(m) : f === 'arrears' ? arrearsOf(m) > 0n : m.status === 'suspended');

/** Members as a register (search, filter) with the chosen member's details and actions beside it. */
export function MembersAdminPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [active, setActive] = useState<{ kind: Kind; member: MemberRow } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const all = members.data?.items ?? [];
  const working = all.filter(isActive);
  const owing = all.filter((m) => arrearsOf(m) > 0n);
  const needle = search.trim().toLowerCase();
  const rows = all.filter((m) => inFilter(m, filter) && (!needle || m.code.toLowerCase().includes(needle) || m.full_name.toLowerCase().includes(needle)));
  const selected = all.find((m) => m.id === selectedId) ?? rows[0] ?? null;
  const counts = Object.fromEntries((['all', 'active', 'arrears', 'suspended'] as const).map((f) => [f, all.filter((m) => inFilter(m, f)).length])) as Record<Filter, number>;

  const choose = (m: MemberRow) => {
    setSelectedId(m.id);
    // below `xl` the panel sits under the list: bring it into view
    if (!window.matchMedia('(min-width: 1280px)').matches) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <AdminPage>
      <AdminHeader
        title={t('membersAdmin.title')}
        subtitle={members.data ? t('adminUi.members.sub', { members: formatCount(working.length), shares: formatCount(working.reduce((n, m) => n + m.shares, 0)) }) : undefined}
      />

      {members.error && <LoadError error={members.error} onRetry={() => void members.refetch()} />}

      <StatGrid>
        <StatTile tone="bg-primary-soft text-primary" icon={ICONS.users} label={t('adminUi.members.statActive')} value={members.data ? formatCount(working.length) : null}
          sub={members.data ? `${t('common.total')} ${formatCount(all.length)}` : undefined} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.layers} label={t('adminUi.members.statShares')} value={members.data ? formatCount(working.reduce((n, m) => n + m.shares, 0)) : null} />
        <StatTile tone="bg-ok-bg text-ok" icon={ICONS.wallet} label={t('adminUi.members.statCapital')} value={members.data ? taka(all.reduce((n, m) => n + BigInt(m.capital_paisa), 0n)) : null} />
        <StatTile tone="bg-bad-bg text-bad" icon={ICONS.alert} label={t('adminUi.members.statArrears')}
          value={members.data ? t('adminDash.people', { n: formatCount(owing.length) }) : null} valueClass={owing.length > 0 ? 'text-bad' : ''}
          sub={members.data ? (owing.length > 0 ? t('adminUi.members.statArrearsSub', { amount: taka(owing.reduce((n, m) => n + arrearsOf(m), 0n)) }) : t('adminDash.allUpToDate')) : undefined} />
      </StatGrid>

      <SplitLayout
        main={
          <Card className="px-5 pb-3 pt-5 sm:px-6">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <label className="relative min-w-0 flex-1 sm:max-w-xs">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon d={ICONS.search} size={18} /></span>
                <input type="search" aria-label={t('adminUi.members.search')} placeholder={t('adminUi.members.search')} className="field w-full pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              <Segmented
                label={t('adminUi.members.filterLabel')}
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: t('common.all'), count: members.data ? formatCount(counts.all) : undefined },
                  { value: 'active', label: t('member.status.active'), count: members.data ? formatCount(counts.active) : undefined },
                  { value: 'arrears', label: t('adminUi.members.filterArrears'), count: members.data ? formatCount(counts.arrears) : undefined },
                  { value: 'suspended', label: t('member.status.suspended'), count: members.data ? formatCount(counts.suspended) : undefined },
                ]}
              />
            </div>

            {!members.data ? (
              <ListSkeleton rows={6} />
            ) : rows.length === 0 ? (
              <EmptyCard text={all.length === 0 ? t('common.noData') : t('adminUi.members.noMatch')} icon={ICONS.search} />
            ) : (
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold text-muted">
                      <th className="border-b border-border px-2 py-2.5">{t('common.member')}</th>
                      <th className="hidden border-b border-border px-2 py-2.5 text-right md:table-cell">{t('membersPage.shares')}</th>
                      <th className="hidden border-b border-border px-2 py-2.5 text-right lg:table-cell">{t('membersPage.capital')}</th>
                      <th className="border-b border-border px-2 py-2.5 text-right">{t('admin.members.due')}</th>
                      <th className="hidden border-b border-border px-2 py-2.5 sm:table-cell">{t('adminUi.members.thisMonth')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const owes = arrearsOf(m);
                      const isSel = selected?.id === m.id;
                      return (
                        <tr key={m.id} aria-selected={isSel} onClick={() => choose(m)} className={`cursor-pointer transition-colors ${isSel ? 'bg-primary-soft' : 'hover:bg-hover'}`}>
                          <td className="border-b border-border px-2 py-2.5">
                            <button type="button" onClick={(e) => { e.stopPropagation(); choose(m); }} className="flex min-w-0 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              <MemberBadge code={m.code} />
                              <span className="min-w-0">
                                <span className="block truncate font-semibold">{m.full_name}</span>
                                {!isActive(m) || m.status === 'warning' ? (
                                  <span className={`mt-0.5 inline-block rounded-full px-2 py-px text-[0.6875rem] font-semibold ${STATUS_TONE[m.status] ?? 'bg-soft text-muted'}`}>{t(`status.member.${m.status}`, { defaultValue: m.status })}</span>
                                ) : null}
                              </span>
                            </button>
                          </td>
                          <td className="hidden border-b border-border px-2 py-2.5 text-right tabular-nums md:table-cell">{formatCount(m.shares)}</td>
                          <td className="hidden border-b border-border px-2 py-2.5 text-right tabular-nums lg:table-cell">{taka(m.capital_paisa)}</td>
                          <td className={`border-b border-border px-2 py-2.5 text-right font-semibold tabular-nums ${owes > 0n ? 'text-bad' : 'text-muted'}`}>{taka(owes)}</td>
                          <td className="hidden border-b border-border px-2 py-2.5 sm:table-cell">
                            {m.under_verification ? <StatusPill status="pending" /> : m.current_period_status ? <StatusPill status={m.current_period_status} /> : <span className="text-muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        }
        side={
          <div ref={panel} className="scroll-mt-4">
            <MemberPanel member={selected} totalShares={all.reduce((a, m) => a + m.shares, 0)} loading={!members.data} isCashier={isCashier} onAction={(kind, member) => setActive({ kind, member })} />
          </div>
        }
      />

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
    </AdminPage>
  );
}

/** The chosen member: figures first, then everything the cashier can do about them. */
interface RegisterRow {
  share_no: number;
  member_id: string;
  registered_name: string;
  nominee_name: string | null;
  nominee_relation: string | null;
}

function MemberPanel({ member: m, totalShares, loading, isCashier, onAction }: { member: MemberRow | null; totalShares: number; loading: boolean; isCashier: boolean; onAction: (kind: Kind, m: MemberRow) => void }) {
  const { t } = useTranslation();
  const register = useQuery({ queryKey: ['share-register'], queryFn: () => api<{ items: RegisterRow[]; total: number }>('/share-register') });
  if (loading) return <Card className="p-5"><Skeleton className="h-64 w-full" /></Card>;
  if (!m) return <Card className="p-5"><EmptyCard text={t('adminUi.members.pick')} icon={ICONS.user} /></Card>;
  const owes = arrearsOf(m);
  const mine = (register.data?.items ?? []).filter((r) => r.member_id === m.id);
  const percent = totalShares > 0 ? Math.round((m.shares * 1000) / totalShares) / 10 : 0;
  const canChange = m.status === 'active' || m.status === 'warning';

  const actions: Array<[Kind, string, boolean]> = [
    ['contact', t('membersAdmin.addContactLog'), true],
    ['pin', t('membersAdmin.issuePin'), isCashier],
    ['reinstatement', t('membersAdmin.reinstate'), isCashier && m.status === 'suspended'],
  ];
  // Rarely used actions (history) and risky ones (red) live behind the three-dot menu next to the name.
  const risky: Array<[Kind, string, boolean, string]> = [
    ['status', t('membersAdmin.statusHistory'), true, ICONS.clock],
    ['settlement', t('membersAdmin.settlement'), isCashier && (canChange || m.status === 'suspended'), ICONS.wallet],
    ['suspension', t('membersAdmin.createSuspension'), isCashier && canChange, ICONS.pause],
  ];
  const menuItems = risky.filter(([, , show]) => show);

  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <MemberBadge code={m.code} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{m.full_name}</p>
          <span className={`mt-0.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[m.status] ?? 'bg-soft text-muted'}`}>
            {t(`status.member.${m.status}`, { defaultValue: m.status })}
          </span>
        </div>
        {menuItems.length > 0 && (
          <Menu.Root>
            <Menu.Trigger aria-label={t('membersAdmin.more')} className="grid h-10 w-10 shrink-0 place-items-center self-start rounded-full text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
              <Icon d="M12 5.5h.01M12 12h.01M12 18.5h.01" sw={3} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-xl border border-border bg-card p-1.5 shadow-card">
                {menuItems.map(([kind, label, , icon]) => (
                  <Menu.Item key={kind} onSelect={() => onAction(kind, m)} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-semibold outline-none ${kind === 'status' ? 'text-ink2 data-[highlighted]:bg-hover' : 'text-bad data-[highlighted]:bg-bad-bg'}`}>
                    <Icon d={icon} size={18} />
                    {label}
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-xl bg-soft px-3 py-2.5">
          <p className="text-xs text-muted">{t('membersPage.capital')}</p>
          <p className="font-bold tabular-nums">{taka(m.capital_paisa)}</p>
        </div>
        <div className={`rounded-xl px-3 py-2.5 ${owes > 0n ? 'bg-bad-bg' : 'bg-soft'}`}>
          <p className="text-xs text-muted">{t('admin.members.due')}</p>
          <p className={`font-bold tabular-nums ${owes > 0n ? 'text-bad' : ''}`}>{taka(owes)}</p>
        </div>
      </div>

      <dl className="mt-3">
        <InfoRow label={t('membersPage.shares')} value={formatCount(m.shares)} />
        <InfoRow label={t('membersAdmin.ownership')} value={`${formatCount(percent)}%`} />
        <InfoRow label={t('adminUi.members.thisMonth')} value={m.under_verification ? <StatusPill status="pending" /> : m.current_period_status ? <StatusPill status={m.current_period_status} /> : '—'} />
        {BigInt(m.outstanding_fines_paisa) > 0n && <InfoRow label={t('matrixPage.fine')} value={taka(m.outstanding_fines_paisa)} valueClass="text-bad" />}
        <InfoRow label={t('admin.members.phone')} value={m.phone ? <a href={`tel:${m.phone}`} className="text-primary hover:underline">{m.phone}</a> : '—'} />
        <InfoRow label={t('admin.members.joined')} value={m.joined_on ? fmtDate(m.joined_on) : '—'} />
      </dl>

      <p className="mb-2 mt-4 text-xs font-semibold text-muted">{t('membersAdmin.shareRegister')}</p>
      {register.error ? <LoadError error={register.error} onRetry={() => void register.refetch()} /> : !register.data ? <Skeleton className="h-16 w-full" /> : mine.length === 0 ? (
        <p className="text-sm text-muted">{t('common.noData')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl bg-soft px-3 text-sm">
          {mine.map((r) => (
            <li key={r.share_no} className="py-2">
              <p className="font-medium"><span className="text-muted">#{formatCount(r.share_no)}</span> {r.registered_name}</p>
              <p className="text-xs text-muted">
                {t('membersPage.nominee')}: {r.nominee_name ? `${r.nominee_name}${r.nominee_relation ? ` (${r.nominee_relation})` : ''}` : '—'}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mb-2 mt-4 text-xs font-semibold text-muted">{t('adminUi.members.actions')}</p>
      <div className="grid grid-cols-2 gap-2">
        {actions.filter(([, , show]) => show).map(([kind, label]) => (
          <button key={kind} type="button" onClick={() => onAction(kind, m)} className={`${BTN_SECONDARY} h-auto min-h-11 px-3 py-2 text-[0.8125rem] leading-snug `}>
            {label}
          </button>
        ))}
      </div>
    </Card>
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
    <AdminDialog open={open} onClose={onClose} title={<>{t('membersAdmin.statusHistory')} — {member.code} {member.full_name}</>}>
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
      <Dialog.Close className={`${BTN_SECONDARY} mt-4 w-full`}>{t('common.close')}</Dialog.Close>
    </AdminDialog>
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
    <AdminDialog open={open} onClose={onClose} title={t('membersAdmin.createSuspension')}>
      <p className="mb-3 text-muted">{member.code} {member.full_name}</p>
      <label className="block text-sm text-muted">
        {t('common.reason')}
        <textarea className="field mt-1 min-h-20 w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('proposal.clauseRef')}
        <input className="field mt-1 w-full" value={clause} onChange={(e) => setClause(e.target.value)} />
      </label>
      {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} className={`${BTN_PRIMARY} flex-1`}>{busy ? t('common.working') : t('common.submit')}</button>
        <Dialog.Close className={`${BTN_SECONDARY} flex-1`}>{t('common.cancel')}</Dialog.Close>
      </div>
    </AdminDialog>
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
    <AdminDialog open={open} onClose={close} title={t('membersAdmin.issuePin')}>
      <p className="mb-1 text-muted">{member.code} {member.full_name}</p>
      {pin === null ? (
        <>
          <p className="mb-3 text-sm text-muted">{t('membersAdmin.issuePinHint')}</p>
          {error != null && <p className="mb-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void issue()} className={`${BTN_PRIMARY} flex-1`}>{busy ? t('common.working') : t('membersAdmin.issuePin')}</button>
            <Dialog.Close className={`${BTN_SECONDARY} flex-1`}>{t('common.cancel')}</Dialog.Close>
          </div>
        </>
      ) : (
        <>
          <p className="my-4 select-all text-center font-mono text-4xl tracking-[0.3em]" data-testid="issued-pin">{pin}</p>
          <p className="mb-3 text-sm text-muted">{t('membersAdmin.issuePinOnce')}</p>
          <button type="button" onClick={close} className={`${BTN_SECONDARY} w-full`}>{t('common.close')}</button>
        </>
      )}
    </AdminDialog>
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
    <AdminDialog open={open} onClose={onClose} title={t('membersAdmin.reinstate')}>
      <p className="mb-1 text-muted">{member.code} {member.full_name}</p>
      <p className="mb-3 text-sm text-muted">{t('membersAdmin.reinstateHint')}</p>
      <label className="block text-sm text-muted">
        {t('proposal.terms')}
        <textarea className="field mt-1 min-h-20 w-full" value={terms} onChange={(e) => setTerms(e.target.value)} />
      </label>
      {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} className={`${BTN_PRIMARY} flex-1`}>{busy ? t('common.working') : t('common.submit')}</button>
        <Dialog.Close className={`${BTN_SECONDARY} flex-1`}>{t('common.cancel')}</Dialog.Close>
      </div>
    </AdminDialog>
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
    <AdminDialog open={open} onClose={onClose} title={t('membersAdmin.settlement')}>
      <p className="mb-3 text-muted">{member.code} {member.full_name}</p>
      <label className="block text-sm text-muted">
        {t('membersAdmin.settlementKind')}
        <select className="field mt-1 w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
          {SETTLEMENT_KINDS.map((k) => (
            <option key={k} value={k}>{t(`settlementKind.${k}`)}</option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('membersAdmin.settlementNetAmount')}
        <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('membersAdmin.settlementDueDate')}
        <input type="date" className="field mt-1 w-full" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>
      {error != null && <p className="mt-2 text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} className={`${BTN_PRIMARY} flex-1`}>{busy ? t('common.working') : t('common.submit')}</button>
        <Dialog.Close className={`${BTN_SECONDARY} flex-1`}>{t('common.cancel')}</Dialog.Close>
      </div>
    </AdminDialog>
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
    <AdminDialog open={open} onClose={onClose} title={<>{t('membersAdmin.contactLogTitle')} — {member.code} {member.full_name}</>}>

      {isCashier && member.status === 'suspended' && (
        <div className="mb-3 rounded-xl bg-primary-soft p-2">
          <button type="button" disabled={busy} onClick={() => void reinstate()} className={`${BTN_PRIMARY} w-full`}>
            {busy ? t('common.working') : t('membersAdmin.reinstate')}
          </button>
          <p className="mt-1 text-xs text-muted">{t('membersAdmin.reinstateHint')}</p>
        </div>
      )}

      {isCashier && (
        <div className="mb-3 space-y-2 rounded-xl border border-border p-2">
          <label className="block text-sm text-muted">
            {t('membersAdmin.contactKind')}
            <select className="field mt-1 w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
              {['call', 'message', 'email', 'registered_letter', 'visit'].map((k) => (
                <option key={k} value={k}>{t(`contactKind.${k}`)}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-muted">
            {t('membersAdmin.contactOutcome')}
            <input className="field mt-1 w-full" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          </label>
          <label className="block text-sm text-muted">
            {t('common.note')}
            <textarea className="field mt-1 min-h-16 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" disabled={busy} onClick={() => void submit()} className={BTN_PRIMARY}>
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
      <Dialog.Close className={`${BTN_SECONDARY} mt-4 w-full`}>{t('common.close')}</Dialog.Close>
    </AdminDialog>
  );
}
