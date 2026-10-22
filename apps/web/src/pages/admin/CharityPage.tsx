import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LEVY_EXPENSE_CATEGORIES, type LevyExpenseCategory } from '@barakah/shared';
import { AccountSelect, type CashAccount } from '../../components/AccountSelect';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, ICONS, MemberBadge, Segmented } from '../../components/admin';
import { Chip, FilePicker } from '../../components/ui';
import { api, apiBlob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/dates';
import { formatCount, localDigits } from '../../lib/format';
import { parseAmountInput, taka } from '../../lib/money';
import type { CharityEntry, CharityStatement, FundExpenses, LevyEntry, LevySummary, MovableCosts } from '../../lib/types';
import { uuid } from '../../lib/uuid';

/*
 * Two funds that never mix (ASSUMPTIONS 105): the charity fund (fines, bank interest, the exit
 * charge) is only ever given away; the levy fund (members' levies) pays the running costs such as
 * bank and SMS charges and photocopies. Each has its own card, colour, balance and list, side by
 * side on a wide screen and as two tabs on a phone.
 */

const CATEGORY_ICON: Record<LevyExpenseCategory, string> = {
  bank_charge: ICONS.wallet,
  sms_charge: ICONS.message,
  photocopy: ICONS.doc,
  registration: ICONS.shield,
  other: ICONS.layers,
};

/** One line of a fund's list: an icon or member badge, what it was, the date, and the amount in or out. */
function Row({ badge, title, sub, amount, into, extra }: { badge: ReactNode; title: string; sub: string; amount: string; into: boolean; extra?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 border-b border-border py-3 last:border-b-0">
      {badge}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{title}</p>
        <p className="text-xs text-muted">{sub}{extra}</p>
      </div>
      <span className={`shrink-0 font-bold tabular-nums ${into ? 'text-ok' : 'text-bad'}`}>
        {into ? '+' : '−'}{taka(amount)}
      </span>
    </li>
  );
}

function CharityRow({ e }: { e: CharityEntry }) {
  const { t } = useTranslation();
  const into = e.direction === 'in';
  const who = e.member_code ? e.member_name : e.recipient ?? e.memo;
  return (
    <Row
      badge={e.member_code ? <MemberBadge code={e.member_code} /> : <Chip tone={into ? 'bg-ok-bg text-ok' : 'bg-vio-bg text-vio'} d={into ? ICONS.plus : ICONS.heart} size={32} iconSize={16} />}
      title={`${t(`charityPage.kind.${e.kind}`)}${who ? ` · ${who}` : ''}`}
      sub={`${fmtDate(e.entry_date)} · #${localDigits(e.seq)}`}
      amount={e.amount_paisa}
      into={into}
    />
  );
}

function LevyRow({ e }: { e: LevyEntry }) {
  const { t } = useTranslation();
  const into = e.direction === 'in';
  const title =
    e.kind === 'collection' ? `${t('fundsPage.levyCollected')} · ${e.member_name ?? ''}`
    : e.kind === 'expense' && e.category ? `${t(`fundsPage.category.${e.category}`)}${e.payee ? ` · ${e.payee}` : ''}`
    : e.kind === 'reversal' ? t('charityPage.kind.reversal')
    : e.memo ?? t('charityPage.kind.other');
  const openReceipt = async () => {
    if (e.receipt_file_id) window.open(URL.createObjectURL(await apiBlob(`/files/${e.receipt_file_id}`)), '_blank', 'noopener');
  };
  return (
    <Row
      badge={e.member_code ? <MemberBadge code={e.member_code} /> : <Chip tone={into ? 'bg-ok-bg text-ok' : 'bg-blue-bg text-blue'} d={e.category ? CATEGORY_ICON[e.category] : ICONS.plus} size={32} iconSize={16} />}
      title={title}
      sub={`${fmtDate(e.entry_date)} · #${localDigits(e.seq)}${e.moved_from_seq ? ` · ${t('fundsPage.movedFrom', { seq: localDigits(e.moved_from_seq) })}` : ''}`}
      amount={e.amount_paisa}
      into={into}
      extra={e.receipt_file_id && <> · <button type="button" onClick={() => void openReceipt()} className="font-semibold text-primary underline">{t('fundsPage.receipt')}</button></>}
    />
  );
}

/** A fund's card: what it is for, what it holds, in and out, its buttons, and its list. */
function FundCard({ icon, tone, title, rule, held, inTotal, outTotal, extraStat, actions, deficitHint, children }: {
  icon: string;
  tone: string;
  title: string;
  rule: string;
  held: string | null;
  inTotal: string | null;
  outTotal: string | null;
  extraStat?: ReactNode;
  actions?: ReactNode;
  deficitHint?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const negative = held !== null && BigInt(held) < 0n;
  return (
    <Card className="px-5 pb-3 pt-5 sm:px-6">
      <CardHead icon={icon} tone={tone} title={title} sub={rule} />
      <div className="mb-4 rounded-2xl bg-soft p-4">
        <p className="text-[0.8125rem] text-muted">{negative ? t('fundsPage.deficit') : t('fundsPage.inHand')}</p>
        <p className={`text-[1.75rem] font-bold leading-tight tabular-nums ${negative ? 'text-bad' : ''}`}>
          {held === null ? '…' : taka(negative ? (-BigInt(held)).toString() : held)}
        </p>
        {negative && deficitHint && <p className="mt-0.5 text-xs text-bad">{deficitHint}</p>}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[0.8125rem]">
          <div className="flex gap-1.5"><dt className="text-muted">{t('fundsPage.cameIn')}</dt><dd className="font-semibold tabular-nums text-ok">{inTotal === null ? '…' : taka(inTotal)}</dd></div>
          <div className="flex gap-1.5"><dt className="text-muted">{t('fundsPage.wentOut')}</dt><dd className="font-semibold tabular-nums text-bad">{outTotal === null ? '…' : taka(outTotal)}</dd></div>
          {extraStat}
        </dl>
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
      <p className="mb-1 text-xs font-semibold text-muted">{t('fundsPage.history')}</p>
      <div className="max-h-[36rem] overflow-y-auto">{children}</div>
    </Card>
  );
}

function CharityFund({ query, canAct }: { query: UseQueryResult<CharityStatement>; canAct: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const st = query.data;
  return (
    <FundCard
      icon={ICONS.heart}
      tone="bg-vio-bg text-vio"
      title={t('fundsPage.charityTitle')}
      rule={t('fundsPage.charityRule')}
      held={st?.closing_paisa ?? null}
      inTotal={st?.receipts_paisa ?? null}
      outTotal={st?.disbursements_paisa ?? null}
      actions={canAct ? <button type="button" className={BTN_SM_PRIMARY} onClick={() => void navigate('/admin/proposals?new=charity_donation')}>{t('fundsPage.donate')}</button> : undefined}
    >
      {query.error ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : !st ? (
        <ListSkeleton rows={3} />
      ) : st.entries.length === 0 ? (
        <EmptyCard text={t('fundsPage.noCharity')} icon={ICONS.heart} />
      ) : (
        // Newest first, like the levy list beside it.
        <ul>{[...st.entries].reverse().map((e) => <CharityRow key={e.seq} e={e} />)}</ul>
      )}
    </FundCard>
  );
}

function LevyFund({ query, canAct, onSpend }: { query: UseQueryResult<LevySummary>; canAct: boolean; onSpend: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lv = query.data;
  const owed = lv?.levies.reduce((n, l) => n + BigInt(l.outstanding_paisa), 0n) ?? 0n;
  return (
    <FundCard
      icon={ICONS.wallet}
      tone="bg-blue-bg text-blue"
      title={t('fundsPage.levyTitle')}
      rule={t('fundsPage.levyRule')}
      held={lv?.held_paisa ?? null}
      inTotal={lv?.in_paisa ?? null}
      outTotal={lv?.out_paisa ?? null}
      deficitHint={t('fundsPage.deficitHint')}
      extraStat={owed > 0n ? <div className="flex gap-1.5"><dt className="text-muted">{t('fundsPage.membersOwe')}</dt><dd className="font-semibold tabular-nums text-warn">{taka(owed)}</dd></div> : undefined}
      actions={canAct ? (
        <>
          <button type="button" className={BTN_SM_PRIMARY} onClick={onSpend}>{t('fundsPage.spend')}</button>
          <button type="button" className={BTN_SM} onClick={() => void navigate('/admin/proposals?new=asset_cost_levy')}>{t('fundsPage.raiseLevy')}</button>
        </>
      ) : undefined}
    >
      {query.error ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : !lv ? (
        <ListSkeleton rows={3} />
      ) : lv.entries.length === 0 ? (
        <EmptyCard text={t('fundsPage.noLevy')} icon={ICONS.wallet} />
      ) : (
        <ul>{lv.entries.map((e) => <LevyRow key={e.seq} e={e} />)}</ul>
      )}
    </FundCard>
  );
}

/**
 * Costs taken from members' capital: those from before the levy fund, and the fund's own upkeep (by
 * vote). Earlier bank and SMS charges can be moved onto the levy fund once (ASSUMPTIONS 106).
 */
function FundExpensesCard({ query, isCashier }: { query: UseQueryResult<FundExpenses>; isCashier: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [moving, setMoving] = useState(false);
  const movable = useQuery({ queryKey: ['levy-movable'], queryFn: () => api<MovableCosts>('/levy/movable-costs'), enabled: isCashier });
  const ex = query.data;
  if (!ex || ex.items.length === 0) return null;
  const canMove = isCashier && (movable.data?.items.length ?? 0) > 0;
  return (
    <Card className="px-5 pb-3 pt-5 sm:px-6">
      <CardHead icon={ICONS.layers} tone="bg-soft text-ink2" title={t('fundsPage.capitalCosts')} sub={t('fundsPage.capitalCostsSub')} action={<span className="font-bold tabular-nums">{taka(ex.total_paisa)}</span>} />
      {canMove && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-blue-bg p-3.5 text-sm">
          <p className="min-w-0 flex-1 text-blue">{t('fundsPage.moveHint', { n: formatCount(movable.data!.items.length), total: taka(movable.data!.total_paisa) })}</p>
          <button type="button" className={BTN_SM_PRIMARY} onClick={() => setMoving(true)}>{t('fundsPage.moveButton')}</button>
        </div>
      )}
      <ul>
        {[...ex.items].reverse().map((x) => (
          <li key={x.seq} className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
            <div className="min-w-0">
              <p className={`truncate font-semibold ${x.moved ? 'text-muted' : ''}`}>{t(`charityPage.account.${x.account}`)}{x.memo ? ` · ${x.memo.replace(/ \(legacy import\)$/, '')}` : ''}</p>
              <p className="text-xs text-muted">{fmtDate(x.entry_date)} · #{localDigits(x.seq)}{x.moved && <span className="font-semibold text-blue"> · {t('fundsPage.movedToLevy')}</span>}</p>
            </div>
            <span className={`shrink-0 font-bold tabular-nums ${x.moved ? 'text-muted line-through' : ''}`}>{taka(x.amount_paisa)}</span>
          </li>
        ))}
      </ul>
      <ConfirmSheet
        open={moving}
        onClose={() => setMoving(false)}
        title={t('fundsPage.moveTitle')}
        confirmLabel={t('fundsPage.moveConfirm')}
        onConfirm={async () => {
          await api('/levy/move-old-costs', { method: 'POST' });
          await Promise.all(['levy', 'levy-movable', 'fund-expenses', 'nav'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
        }}
      >
        <p className="text-sm">{t('fundsPage.moveExplain')}</p>
        <ul className="rounded-xl bg-soft px-3 text-sm">
          {movable.data?.items.map((c) => (
            <li key={c.seq} className="flex justify-between gap-3 border-b border-border py-2 last:border-b-0">
              <span className="min-w-0 truncate">{t(`charityPage.account.${c.account}`)} · {fmtDate(c.entry_date)} · #{localDigits(c.seq)}</span>
              <span className="shrink-0 font-semibold tabular-nums">{taka(c.amount_paisa)}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm font-semibold">{t('fundsPage.moveTotal', { total: taka(movable.data?.total_paisa ?? '0') })}</p>
        <p className="text-xs text-muted">{t('fundsPage.moveAfter')}</p>
      </ConfirmSheet>
    </Card>
  );
}

/** The cashier's "write down a levy expense" sheet: within the no-vote limit, and within what is held unless the bank took it. */
function SpendSheet({ open, onClose, levy }: { open: boolean; onClose: () => void; levy: LevySummary | undefined }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [category, setCategory] = useState<LevyExpenseCategory>('bank_charge');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<CashAccount>('BANK');
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const paisa = parseAmountInput(amount);
  const limit = levy?.limit_paisa ? BigInt(levy.limit_paisa) : null;
  const held = levy ? BigInt(levy.held_paisa) : 0n;
  const overLimit = paisa !== null && limit !== null && category !== 'registration' && BigInt(paisa) > limit;
  const overHeld = paisa !== null && category !== 'bank_charge' && category !== 'sms_charge' && BigInt(paisa) > held;

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={t('fundsPage.spendTitle')}
      confirmLabel={t('common.confirm')}
      canConfirm={paisa !== null && !overLimit && !overHeld && payee.trim().length > 0 && note.trim().length >= 3}
      onConfirm={async () => {
        let receipt: string | undefined;
        if (file) {
          const form = new FormData();
          form.append('file', file);
          receipt = (await api<{ id: string }>('/files', { method: 'POST', body: form, headers: { 'Idempotency-Key': uuid() } })).id;
        }
        await api('/levy/expenses', { method: 'POST', body: { category, amount_paisa: paisa, account, payee: payee.trim(), note: note.trim(), receipt_file_id: receipt } });
        setAmount('');
        setPayee('');
        setNote('');
        setFile(null);
        void qc.invalidateQueries({ queryKey: ['levy'] });
        void qc.invalidateQueries({ queryKey: ['nav'] });
      }}
    >
      <label className="field-label">{t('fundsPage.whatFor')}
        <select className="field mt-1 w-full" value={category} onChange={(e) => setCategory(e.target.value as LevyExpenseCategory)}>
          {LEVY_EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`fundsPage.category.${c}`)}</option>)}
        </select>
      </label>
      <label className="field-label">{t('common.amount')}
        <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="spend-hint" />
      </label>
      <p id="spend-hint" className="field-hint">
        {limit !== null && t('fundsPage.limitHint', { limit: taka(limit.toString()) })}
      </p>
      {overLimit && (
        <div className="rounded-xl bg-warn-bg p-3 text-sm text-warn">
          {t('fundsPage.needsVote')}{' '}
          <button type="button" className="font-semibold underline" onClick={() => { onClose(); void navigate('/admin/proposals?new=expense'); }}>{t('fundsPage.makeProposal')}</button>
        </div>
      )}
      {overHeld && !overLimit && <p className="rounded-xl bg-bad-bg p-3 text-sm text-bad">{t('fundsPage.notEnough', { held: taka((held < 0n ? 0n : held).toString()) })}</p>}
      <AccountSelect value={account} onChange={setAccount} />
      <label className="field-label">{t('fundsPage.payee')}
        <input className="field mt-1 w-full" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder={t('fundsPage.payeeExample')} />
      </label>
      <label className="field-label">{t('assetsAdmin.note')}
        <textarea className="field mt-1 min-h-16 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div>
        <span className="field-label">{t('fundsPage.receipt')}<span className="field-optional"> ({t('common.optional')})</span></span>
        <FilePicker className="mt-1" file={file} onChange={setFile} />
      </div>
    </ConfirmSheet>
  );
}

export function CharityPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [tab, setTab] = useState<'charity' | 'levy'>('charity');
  const [spending, setSpending] = useState(false);

  // From the start: the owner reads each fund as "what came in, what went out, what is left".
  const statement = useQuery({ queryKey: ['charity-statement', 'all'], queryFn: () => api<CharityStatement>('/charity/statement') });
  const levy = useQuery({ queryKey: ['levy'], queryFn: () => api<LevySummary>('/levy') });
  const expenses = useQuery({ queryKey: ['fund-expenses'], queryFn: () => api<FundExpenses>('/charity/expenses') });

  return (
    <AdminPage>
      <AdminHeader title={t('fundsPage.title')} subtitle={t('fundsPage.subtitle')} />

      <div className="xl:hidden">
        <Segmented label={t('fundsPage.title')} value={tab} onChange={setTab} options={[{ value: 'charity', label: t('fundsPage.charityTitle') }, { value: 'levy', label: t('fundsPage.levyTitle') }]} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className={tab === 'charity' ? '' : 'hidden xl:block'}><CharityFund query={statement} canAct={isCashier} /></div>
        <div className={tab === 'levy' ? '' : 'hidden xl:block'}><LevyFund query={levy} canAct={isCashier} onSpend={() => setSpending(true)} /></div>
      </div>

      <FundExpensesCard query={expenses} isCashier={isCashier} />

      <SpendSheet open={spending} onClose={() => setSpending(false)} levy={levy.data} />
    </AdminPage>
  );
}
