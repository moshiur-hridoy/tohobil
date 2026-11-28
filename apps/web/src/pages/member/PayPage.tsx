import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@barakah/shared';
import { Icon, Optional, PageHeader, DateInput } from '../../components/ui';
import { FilePicker } from '../../components/FilePicker';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { CopyButton } from '../../components/CopyButton';
import { ListSkeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { uuid } from '../../lib/uuid';
import { useAuth } from '../../lib/auth';
import { dayToIso, fmtDate, fmtInstant, fmtPeriod, todayDhaka } from '../../lib/dates';
import { paisaToDecimal, parseAmountInput, taka, takaExact } from '../../lib/money';
import { monthsAhead } from '../../lib/advance';
import { BKASH_CHARGE_PER_THOUSAND, FILL_ORDER, bkashGross, bkashNet, fillRows, type FillPart } from '../../lib/sendMoney';
import type { DueRow, FineRow, MandateRow, Page, PaymentDetail, PaymentInstructions, PaymentRow } from '../../lib/types';

const NEEDS_TRX: PaymentMethod[] = ['bkash', 'nagad', 'bank'];
/** How many months ahead a member can add on the pay page. */
const MAX_AHEAD = 12;
/** How many upcoming months are listed (unticked) before the member asks for more. */
const SHOWN_AHEAD = 2;
const INFO_ICON = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.01';

/** How to pay the fund: the numbers, and which methods members may pick (shared cache with the sheet). */
function useInstructions() {
  return useQuery({ queryKey: ['payment-instructions'], queryFn: () => api<PaymentInstructions>('/settings/payment-instructions'), staleTime: 5 * 60_000 });
}

export function PayPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [howTo, setHowTo] = useState(false);

  const dues = useQuery({
    queryKey: ['dues', 'me', me?.member_id],
    enabled: !!me,
    queryFn: () => api<Page<DueRow>>(`/dues?member_id=${me?.member_id}&limit=60`),
  });
  const fines = useQuery({
    queryKey: ['fines', 'me', me?.member_id],
    enabled: !!me,
    queryFn: () => api<Page<FineRow>>(`/fines?member_id=${me?.member_id}&limit=60`),
  });
  // Advance already accepted (credit) and payments still with the cashier: the months they pay are
  // not offered again.
  const detail = useQuery({
    queryKey: ['member', me?.member_id],
    enabled: !!me?.member_id,
    queryFn: () => api<{ credit_paisa?: string }>(`/members/${me?.member_id}`),
  });
  const pending = useQuery({
    queryKey: ['payments', 'me', 'pending', me?.member_id],
    enabled: !!me?.member_id,
    queryFn: () => api<Page<PaymentRow>>(`/payments?member_id=${me?.member_id}&status=pending&limit=50`),
  });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['member', me?.member_id] }), qc.invalidateQueries({ queryKey: ['dues'] }), qc.invalidateQueries({ queryKey: ['fines'] }), qc.invalidateQueries({ queryKey: ['payments'] }), qc.invalidateQueries({ queryKey: ['members'] })]);

  const openDues = (dues.data?.items ?? []).filter((d) => BigInt(d.outstanding_paisa) > 0n).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const openFines = (fines.data?.items ?? []).filter((f) => BigInt(f.outstanding_paisa) > 0n && f.status !== 'waived' && f.status !== 'cancelled');

  return (
    <PullToRefresh onRefresh={refresh}>
      <PageHeader
        title={t('payment.title')}
        subtitle={t('pay.subtitle')}
        action={
          <button type="button" onClick={() => setHowTo(true)} className="-mx-2 flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-accent hover:bg-hover">
            <Icon d={INFO_ICON} size={18} />
            {t('pay.howTo')}
          </button>
        }
      />
      <HowToPaySheet open={howTo} onClose={() => setHowTo(false)} />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-2">
        {dues.error ? (
          <LoadError error={dues.error} onRetry={() => void dues.refetch()} />
        ) : fines.error ? (
          <LoadError error={fines.error} onRetry={() => void fines.refetch()} />
        ) : !dues.data || !fines.data || !detail.data || !pending.data ? (
          <div className="rounded-lg border border-border bg-card p-4"><ListSkeleton rows={3} /></div>
        ) : (
          // Mounted once the dues are in, so the default ticks see them. Not re-keyed on refresh: coming
          // back from the bKash app refetches, and that must not wipe what the member has typed.
          <SendMoneyForm
            allDues={dues.data.items}
            openDues={openDues}
            openFines={openFines}
            creditPaisa={detail.data.credit_paisa ?? '0'}
            pendingPeriods={new Set(pending.data.items.flatMap((p) => p.for_periods ?? []))}
            onSent={() => void refresh()}
          />
        )}
        <History memberId={me?.member_id} />
      </div>
    </PullToRefresh>
  );
}

/**
 * One part of the form: the page reads top to bottom as "how, what, then the details". With `flush`
 * the content runs edge to edge (lists and bands), so a phone never shows a box inside a box.
 */
function Step({ title, hint, flush, children }: { title: string; hint?: string; flush?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby={id}>
      <div className="border-b border-border px-4 py-3.5">
        <h2 id={id} className="text-lg font-bold leading-7">{title}</h2>
        {hint && <p className="text-meta leading-snug text-muted">{hint}</p>}
      </div>
      <div className={flush ? undefined : 'p-4'}>{children}</div>
    </section>
  );
}

/** A row of choices as one bar, the chosen one filled. Wraps when a cashier enables many methods. */
const segmentBar = 'grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-1 rounded-lg border border-edge bg-soft p-1';
const segment = (chosen: boolean) => `rounded-md text-sm ${chosen ? 'bg-accent-fill font-bold text-on-accent' : 'text-ink2 hover:bg-hover'}`;

type Purpose = 'dues' | 'levy' | 'special';
const PURPOSES: readonly Purpose[] = ['dues', 'special', 'levy'];
const SEPARATE_KINDS = new Set<string>(['levy', 'special']);
const PURPOSE_LABEL: Record<Purpose, string> = { dues: 'pay.purposeDues', levy: 'pay.purposeLevy', special: 'pay.purposeSpecial' };

/**
 * The member ticks what they are paying for and the total is worked out from the dues, so a mistyped
 * figure cannot unbalance the books. Months are paid oldest first: ticking a month ticks every earlier
 * one, unticking it unticks the later ones. With bKash they may instead type what they sent (ASSUMPTIONS
 * 134): the charge is taken out, and the rest fills the months in the order the server will pay them.
 */
function SendMoneyForm({
  allDues,
  openDues,
  openFines,
  creditPaisa,
  pendingPeriods,
  onSent,
}: {
  allDues: DueRow[];
  openDues: DueRow[];
  openFines: FineRow[];
  creditPaisa: string;
  pendingPeriods: ReadonlySet<string>;
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const today = todayDhaka();
  const currentPeriod = today.slice(0, 7);
  const [purpose, setPurpose] = useState<Purpose>('dues');
  const [chosenMethod, setMethod] = useState<PaymentMethod | null>(null);
  // Dues sent straight to a shop under its standing approval (ASSUMPTIONS 131); null = the fund's account.
  const [shopId, setShopId] = useState<string | null>(null);
  const mandates = useQuery({
    queryKey: ['mandates'],
    queryFn: () => api<{ items: MandateRow[] }>('/mandates'),
    select: (r) => r.items.filter((m) => m.status === 'active'),
  });
  const [digits, setDigits] = useState('');
  // Cash only: how it was handed over, in the member's own words, for the cashier.
  const [cashNote, setCashNote] = useState('');
  const [date, setDate] = useState(today);
  const [file, setFile] = useState<File | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // bKash only: the amount sent, charge included, as typed. While `byAmount` it drives the ticks;
  // after a month is tapped the ticks drive it and the box shows what they cost with the charge.
  const [sentText, setSentText] = useState('');
  const [byAmount, setByAmount] = useState(false);
  // The box stays folded away until "other amount" is tapped.
  const [otherOpen, setOtherOpen] = useState(false);
  // The amount just sent: while set, a confirmation card tells the member it is with the cashier.
  const [sentAmount, setSentAmount] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // One key per attempt, so a retry after a dropped connection can never create a second payment.
  const attemptKey = useRef(uuid());

  const instructions = useInstructions();
  // The cashier picks which methods members see; until that loads the usual three are offered.
  const methods = instructions.data?.methods?.length ? instructions.data.methods : (['bkash', 'bank', 'cash'] as PaymentMethod[]);
  const method: PaymentMethod = chosenMethod && methods.includes(chosenMethod) ? chosenMethod : methods[0]!;
  const canTypeAmount = method === 'bkash' && purpose === 'dues';
  const amountMode = canTypeAmount && byAmount && sentText.trim() !== '';
  /** Folds the box away and forgets what was typed, so a hidden figure can never be sent. */
  const closeOther = () => {
    setOtherOpen(false);
    setSentText('');
    setByAmount(false);
  };

  // Levy and a special contribution are paid on their own, so a monthly payment never lands on them.
  const purposes = PURPOSES.filter((p) => p === 'dues' || openDues.some((d) => d.kind === p));
  const dues = openDues.filter((d) => (purpose === 'dues' ? !SEPARATE_KINDS.has(d.kind) : d.kind === purpose));
  const fines = purpose === 'dues' ? openFines : [];

  // One row per month (a month can hold a monthly due and a start boost); a month's fine goes with it.
  const months = [...new Set(dues.map((d) => d.period))].sort().map((period) => {
    const list = dues.filter((d) => d.period === period);
    const fine = fines.filter((f) => f.period === period).reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
    const principal = list.reduce((sum, d) => sum + BigInt(d.outstanding_paisa), 0n);
    const dueDate = list.map((d) => d.due_date).sort()[0] ?? `${period}-01`;
    return {
      period,
      list,
      fine,
      principal,
      dueDate,
      // A payment for it is already with the cashier: shown, but not offered again.
      verifying: list.some((d) => d.under_verification),
      status: list.some((d) => d.status === 'overdue') ? 'overdue' : list.some((d) => d.status === 'partial') ? 'partial' : 'unpaid',
    };
  });
  // Paying ahead (ASSUMPTIONS 99): the next months, whose dues do not exist yet, are listed unticked
  // at the latest monthly due's amount, and more can be added one at a time. The server keeps the
  // money as credit and applies it when the dues job creates that month, so nothing here has to match a due exactly.
  // Advance already accepted pays the first of those months, so they are not offered again; a month
  // named in a payment still with the cashier is shown as waiting, like an existing due.
  const lastMonthly = allDues.filter((d) => d.kind === 'monthly').sort((a, b) => b.period.localeCompare(a.period))[0];
  const lastPeriod = [lastMonthly?.period ?? currentPeriod, currentPeriod].sort().at(-1)!;
  const owed = months.length;
  const [ahead, setAhead] = useState(SHOWN_AHEAD);
  if (purpose === 'dues' && lastMonthly) {
    for (const { period, need } of monthsAhead(lastPeriod, BigInt(lastMonthly.amount_paisa), creditPaisa, amountMode ? MAX_AHEAD : ahead)) {
      months.push({ period, list: [], fine: 0n, principal: need, dueDate: `${period}-01`, verifying: pendingPeriods.has(period), status: 'advance' });
    }
  }
  const nextAhead = lastMonthly && purpose === 'dues' && ahead < MAX_AHEAD;
  const payable = months.filter((m) => !m.verifying);
  const looseFines = fines.filter((f) => !f.period || !months.some((m) => m.period === f.period));

  // Ticked by default: everything already due, so the usual case needs no decision at all.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set([...payable.filter((m) => m.dueDate <= today).map((m) => m.period), ...looseFines.map((f) => f.id)]),
  );
  const addAhead = () => {
    if (!nextAhead) return;
    setAhead((n) => n + 1);
  };
  const shop = purpose === 'dues' ? (mandates.data?.find((m) => m.partner_id === shopId) ?? null) : null;

  // The typed amount, spread over the rows as the confirmation will spread it.
  const parts: FillPart[] = [
    ...payable.flatMap((m): FillPart[] =>
      m.list.length === 0
        ? [{ key: m.period, amount: m.principal, order: FILL_ORDER.noDueYet }]
        : m.list.map((d) => ({ key: m.period, amount: BigInt(d.outstanding_paisa), order: d.due_date > today ? FILL_ORDER.notYetDue : FILL_ORDER.due })),
    ),
    // Money sent to a shop never pays a fine (ASSUMPTIONS 131).
    ...(shop
      ? []
      : [
          ...payable.map((m): FillPart => ({ key: m.period, amount: m.fine, order: FILL_ORDER.fine })),
          ...looseFines.map((f): FillPart => ({ key: f.id, amount: BigInt(f.outstanding_paisa), order: FILL_ORDER.fine })),
        ]),
  ];
  const typedPaisa = amountMode ? parseAmountInput(sentText) : null;
  const typedNet = typedPaisa ? bkashNet(BigInt(typedPaisa)) : 0n;
  const fill = amountMode ? fillRows(parts, typedNet) : null;
  const needOf = (key: string) => {
    const m = payable.find((x) => x.period === key);
    if (m) return m.principal + m.fine;
    return BigInt(looseFines.find((f) => f.id === key)?.outstanding_paisa ?? '0');
  };
  /** Ticked: picked by hand, or paid in full by the typed amount. */
  const ticked = fill ? new Set([...fill.covered].filter(([key, got]) => got === needOf(key)).map(([key]) => key)) : picked;
  const touched = (key: string) => (fill ? fill.covered.has(key) : picked.has(key));
  // With a typed amount, list as far as it reaches and a couple of months more.
  const lastReached = months.reduce((at, m, i) => (fill?.covered.has(m.period) ? i : at), -1);
  const shownMonths = fill ? months.slice(0, Math.max(owed + ahead, lastReached + 1 + SHOWN_AHEAD)) : months;

  /** A tap starts from what is ticked now and switches back to picking by hand. */
  const pickByHand = (change: (next: Set<string>) => void) => {
    const next = new Set(ticked);
    change(next);
    setPicked(next);
    if (fill) setAhead((n) => Math.max(n, shownMonths.length - owed));
    setByAmount(false);
  };
  const toggleMonth = (period: string) =>
    pickByHand((next) => {
      const on = !next.has(period);
      for (const m of payable) {
        if (on && m.period <= period) next.add(m.period);
        if (!on && m.period >= period) next.delete(m.period);
      }
    });
  const toggleFine = (id: string) =>
    pickByHand((next) => {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    });

  const chosen = payable.filter((m) => touched(m.period));
  const chosenLoose = looseFines.filter((f) => touched(f.id));
  const fineTotal = fill
    ? fill.fines
    : chosen.reduce((sum, m) => sum + m.fine, 0n) + chosenLoose.reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
  const total = fill
    ? typedNet
    : chosen.reduce((sum, m) => sum + m.principal, 0n) + fineTotal;
  const periods = chosen.map((m) => m.period);
  // What the amount box shows, and the sent amount and charge when it is in use.
  const sentValue = byAmount || sentText === '' ? sentText : total > 0n ? paisaToDecimal(bkashGross(total)) : '';
  const sentPaisa = canTypeAmount ? parseAmountInput(sentValue) : null;
  const charge = sentPaisa ? BigInt(sentPaisa) - total : 0n;

  // Bengali digits are accepted and turned into 0-9; exactly four are kept as the sender's identity.
  const senderDigits = /^\d{4}$/.test(toAscii(digits.trim())) ? toAscii(digits.trim()) : '';
  const paisa = total > 0n ? total.toString() : null;
  const trxNeeded = NEEDS_TRX.includes(method);
  const noteText = method === 'cash' ? cashNote.trim() : '';
  // The cashier matches the bKash message, which shows the sent amount, so it travels in the note.
  const note = [
    senderDigits ? t(method === 'bank' ? 'pay.senderNoteBank' : 'pay.senderNotePhone', { digits: senderDigits }) : '',
    sentPaisa ? t('pay.bkashNote', { sent: takaExact(sentPaisa), charge: takaExact(charge) }) : '',
    noteText,
  ].filter(Boolean).join('\n').slice(0, 500);
  const readOnly = !!me?.read_only;

  const review = () => {
    setDone(false);
    if (!paisa) return setInvalid(t(amountMode ? 'pay.invalidAmount' : 'pay.pickSomething'));
    if (date > todayDhaka()) return setInvalid(t('pay.invalidDate'));
    if (digits.trim() && !senderDigits) return setInvalid(t('pay.senderDigitsInvalid'));
    if (trxNeeded && !senderDigits) return setInvalid(t('errors.payment.trx_required'));
    setInvalid(null);
    attemptKey.current = uuid();
    setSheet(true);
  };

  const send = async () => {
    let proof: string | undefined;
    if (file) {
      const form = new FormData();
      form.append('file', file);
      const up = await api<{ id: string }>('/files', { method: 'POST', body: form, headers: { 'Idempotency-Key': `${attemptKey.current}-file` } });
      proof = up.id;
    }
    await api('/payments', {
      method: 'POST',
      headers: { 'Idempotency-Key': attemptKey.current },
      body: {
        amount_paisa: paisa,
        method,
        ...(note ? { note } : {}),
        paid_at: dayToIso(date),
        ...(purpose !== 'dues' ? { purpose } : {}),
        ...(periods.length > 0 ? { for_periods: periods.slice(0, 24) } : {}),
        ...(proof ? { proof_file_id: proof } : {}),
        ...(shop ? { partner_id: shop.partner_id } : {}),
      },
    });
    setPicked(new Set());
    closeOther();
    setAhead(SHOWN_AHEAD);
    setDigits('');
    setCashNote('');
    setPurpose('dues');
    setShopId(null);
    setFile(null);
    setDone(true);
    setSentAmount(takaExact(paisa as string));
    window.scrollTo({ top: 0 });
    onSent();
  };

  const field = 'field field-lg mt-1.5 w-full';
  const label = 'field-label';
  const hint = 'field-hint';

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <Step title={t('pay.step2')}>
        <div role="radiogroup" aria-label={t('pay.step2')} className={segmentBar}>
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`h-11 ${segment(method === m)}`}
            >
              {t(`pay.via.${m}`)}
            </button>
          ))}
        </div>
      </Step>

      <Step flush title={t('pay.step1')}>
        {purposes.length > 1 && (
          <div role="radiogroup" aria-label={t('pay.purposeLabel')} className={`m-4 ${segmentBar}`}>
            {purposes.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={purpose === p}
                onClick={() => { setPurpose(p); setPicked(new Set()); closeOther(); }}
                className={`py-2 ${segment(purpose === p)}`}
              >
                {t(PURPOSE_LABEL[p])}
              </button>
            ))}
          </div>
        )}

        {owed + looseFines.length === 0 && months.length > 0 && <p className="bg-ok-bg px-4 py-3 text-center text-sm font-semibold text-ok">{t('pay.noDuesAhead')}</p>}
        {months.length + looseFines.length === 0 ? (
          <p className="bg-ok-bg p-4 text-center font-semibold text-ok">{t('pay.noDues')}</p>
        ) : (
          // min-w-0: a fieldset is otherwise as wide as its longest row, which overflows at large text.
          <fieldset className="min-w-0">
            <legend className="sr-only">{t('pay.step1')}</legend>
            <ul className="divide-y divide-border">
              {shownMonths.map((m) => {
                const got = fill?.covered.get(m.period) ?? 0n;
                const part = got > 0n && got < m.principal + m.fine;
                const kinds = [...new Set(m.list.map((d) => d.kind))].filter((k) => k !== 'monthly');
                return (
                  <PickRow
                    key={m.period}
                    checked={!m.verifying && ticked.has(m.period)}
                    partial={part}
                    disabled={m.verifying}
                    onToggle={() => toggleMonth(m.period)}
                    title={`${fmtPeriod(m.period)}${kinds.length ? ` · ${kinds.map((k) => t(`pay.dueKind.${k}`)).join(', ')}` : ''}`}
                    sub={part ? t('pay.rowPartial', { paid: takaExact(got), left: takaExact(m.principal + m.fine - got) }) : m.fine > 0n ? t('pay.withFine', { due: taka(m.principal), fine: taka(m.fine) }) : m.list.length === 0 ? undefined : t('pay.dueDate', { date: fmtDate(m.dueDate) })}
                    subBad={!part && m.fine > 0n}
                    amount={taka(m.principal + m.fine)}
                    status={m.verifying ? 'pending' : m.period > currentPeriod ? 'advance' : m.status}
                  />
                );
              })}
              {looseFines.map((f) => (
                <PickRow
                  key={f.id}
                  checked={ticked.has(f.id)}
                  partial={touched(f.id) && !ticked.has(f.id)}
                  onToggle={() => toggleFine(f.id)}
                  title={`${t('pay.fineLabel')}${f.period ? ` · ${fmtPeriod(f.period)}` : ''}`}
                  sub={fill && touched(f.id) && !ticked.has(f.id) ? t('pay.rowPartial', { paid: takaExact(fill.covered.get(f.id) ?? 0n), left: takaExact(BigInt(f.outstanding_paisa) - (fill.covered.get(f.id) ?? 0n)) }) : undefined}
                  amount={taka(f.outstanding_paisa)}
                  status="overdue"
                />
              ))}
            </ul>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center border-t border-border px-1.5 py-2.5 empty:hidden">
          {nextAhead && !fill && (
            <button type="button" onClick={addAhead} className="flex min-h-12 items-center gap-1 rounded-lg px-2 text-meta font-semibold text-accent hover:bg-hover">
              <Icon d="M12 5v14M5 12h14" size={16} sw={2} />
              {t('pay.addAhead')}
            </button>
          )}
          {canTypeAmount && (
            <button type="button" aria-expanded={otherOpen} onClick={() => (otherOpen ? closeOther() : setOtherOpen(true))} className="ml-auto flex min-h-12 items-center rounded-lg px-2 text-meta font-semibold text-accent underline underline-offset-4 hover:bg-hover">
              {t('pay.otherAmount')}
            </button>
          )}
        </div>
        {months.slice(owed).some((m) => touched(m.period)) && <p className="field-hint px-4 pb-3">{t('pay.aheadHint')}</p>}

        {canTypeAmount && otherOpen && (
          <div className="px-4 pb-4 pt-1">
            <label className="block">
              <span className={label}>{t('pay.sentAmount')}</span>
              <input className={field} autoFocus inputMode="decimal" value={sentValue} onChange={(e) => { setSentText(e.target.value); setByAmount(true); }} placeholder={t('pay.sentAmountExample')} autoComplete="off" />
              <span className={hint}>{t('pay.sentAmountHint')}</span>
            </label>
            {sentPaisa && (
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-ink2">{t('pay.bkashSent')}</dt><dd className="font-semibold">{takaExact(sentPaisa)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-ink2">{t('pay.bkashCharge', { rate: takaExact(BKASH_CHARGE_PER_THOUSAND) })}</dt><dd className="font-semibold">−{takaExact(charge)}</dd></div>
              </dl>
            )}
            {fill && fill.leftover > 0n && <p className="mt-2 text-sm text-warn">{t('pay.leftover', { amount: takaExact(fill.leftover) })}</p>}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border bg-accent-soft px-4 py-3" aria-live="polite">
          <div>
            <p className="text-body font-semibold text-ink2">{t(sentPaisa ? 'pay.totalCredit' : 'pay.payableTotal')}</p>
            {fineTotal > 0n && <p className="text-xs font-semibold text-bad">{t('pay.includesFine', { fine: taka(fineTotal) })}</p>}
          </div>
          <p data-testid="pay-total" className="text-figure font-bold leading-tight text-accent">{takaExact(total)}</p>
        </div>
      </Step>

      {purpose === 'dues' && (mandates.data?.length ?? 0) > 0 && (
        <Step flush title={t('pay.whereTitle')}>
          <div role="radiogroup" aria-label={t('pay.whereTitle')} className="divide-y divide-border">
            {[null, ...mandates.data!].map((m) => (
              <button
                key={m?.id ?? 'fund'}
                type="button"
                role="radio"
                aria-checked={(shopId ?? null) === (m?.partner_id ?? null)}
                onClick={() => setShopId(m?.partner_id ?? null)}
                className={`flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${(shopId ?? null) === (m?.partner_id ?? null) ? 'bg-accent-soft font-bold text-accent' : 'text-ink2 hover:bg-hover'}`}
              >
                {m ? t('pay.whereShop', { name: m.partner_name }) : t('pay.whereFund')}
                {(shopId ?? null) === (m?.partner_id ?? null) && <Icon d="M5 12l5 5 9-10" size={18} sw={2.4} />}
              </button>
            ))}
          </div>
          {shop && <p className="field-hint border-t border-border px-4 py-3">{t(fineTotal > 0n ? 'pay.whereShopFineHint' : 'pay.whereShopHint', { name: shop.partner_name })}</p>}
        </Step>
      )}

      <Step title={t('pay.step3')} hint={t('pay.step3Hint')}>
        <div className="space-y-3.5">
          {trxNeeded && (
            <label className="block">
              <span className={label}>{t(method === 'bank' ? 'pay.senderDigitsBank' : 'pay.senderDigitsPhone')}</span>
              <input className={field} inputMode="numeric" maxLength={8} value={digits} onChange={(e) => setDigits(e.target.value)} placeholder={t('pay.digitsExample')} autoComplete="off" />
            </label>
          )}

          {method === 'cash' && (
            <label className="block">
              <span className={label}>{t('pay.cashNote')}<Optional /></span>
              <textarea className={`${field} min-h-24 py-3`} maxLength={500} value={cashNote} onChange={(e) => setCashNote(e.target.value)} placeholder={t('pay.cashNotePlaceholder')} />
              <span className={hint}>{t('pay.cashNoteHint')}</span>
            </label>
          )}

          <label className="block">
            <span className={label}>{t('pay.sentOn')}</span>
            <DateInput className={field} value={date} max={todayDhaka()} onChange={(e) => setDate(e.target.value)} />
          </label>

          <div>
            <span className={label}>{t('pay.screenshotLabel')}<Optional /></span>
            <FilePicker className="mt-1.5" file={file} onChange={setFile} label={t('pay.screenshotLabel')} accept="image/jpeg,image/png,image/webp,application/pdf" />
          </div>
        </div>
      </Step>

      {invalid && <p role="alert" className="px-1 text-bad">{invalid}</p>}
      {done && <p role="status" className="rounded-lg bg-ok-bg p-3 text-ok">{t('pay.sent')}</p>}

      <button type="submit" disabled={readOnly} className="btn btn-primary btn-lg w-full">
        {t('pay.send')}
        {total > 0n && <span>· {takaExact(total)}</span>}
      </button>
      {readOnly && <p className="text-warn">{t('errors.auth.read_only')}</p>}

      <Dialog.Root open={sentAmount !== null} onOpenChange={(o) => !o && setSentAmount(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content aria-describedby="pay-sent-body" className="fixed left-1/2 top-1/2 z-50 w-[min(24rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 text-center shadow-lift">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-ok-bg text-ok"><Icon d="M5 12l5 5 9-10" size={28} sw={2.4} /></span>
            <Dialog.Title className="mt-4 text-lg font-bold">{t('pay.sentTitle')}</Dialog.Title>
            <p id="pay-sent-body" className="mt-2 text-ink2">{t('pay.sentBody', { amount: sentAmount ?? '' })}</p>
            <Dialog.Close className="btn btn-primary mt-5 w-full">{t('pay.sentOk')}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmSheet open={sheet} onClose={() => setSheet(false)} title={t('pay.reviewTitle')} confirmLabel={t('pay.send')} onConfirm={send}>
        <SheetRow label={t('payment.amount')} value={paisa ? takaExact(paisa) : ''} strong />
        {sentPaisa && <SheetRow label={t('pay.bkashSent')} value={takaExact(sentPaisa)} />}
        {sentPaisa && <SheetRow label={t('pay.bkashCharge', { rate: takaExact(BKASH_CHARGE_PER_THOUSAND) })} value={`−${takaExact(charge)}`} />}
        <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
        {shop && <SheetRow label={t('pay.whereTitle')} value={shop.partner_name} />}
        {senderDigits && <SheetRow label={t(method === 'bank' ? 'pay.senderDigitsBank' : 'pay.senderDigitsPhone')} value={senderDigits} />}
        {noteText && <SheetRow label={t('pay.cashNote')} value={<span className="whitespace-pre-line">{noteText}</span>} />}
        <SheetRow label={t('payment.date')} value={fmtDate(date)} />
        {periods.length > 0 && <SheetRow label={t('payment.period')} value={periods.map(fmtPeriod).join(', ')} />}
        <p className="pt-2 text-muted">{t('pay.reviewBody')}</p>
      </ConfirmSheet>
    </form>
  );
}

/** The "how do I send it?" sheet: every enabled method's numbers, each copyable, with a one-line guide. */
function HowToPaySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const instructions = useInstructions();
  const data = instructions.data;
  const methods = data?.methods?.length ? data.methods : (['bkash', 'bank', 'cash'] as PaymentMethod[]);

  const section = (m: PaymentMethod) => {
    if (!data) return null;
    if (m === 'bkash' || m === 'nagad') {
      return (
        <>
          <p className="text-sm text-ink2">{t('pay.howToWallet', { method: PAYMENT_METHOD_LABELS[m].bn })}</p>
          {data[m] ? <CopyRow label={t('pay.number')} value={data[m]} /> : <p className="text-sm text-muted">{t('pay.noInstructions')}</p>}
        </>
      );
    }
    if (m === 'bank') {
      const rows: Array<[string, string | undefined]> = data.bank_account
        ? [[t('pay.bankAccount'), data.bank_account], [t('pay.bankHolder'), data.bank_holder], [t('pay.bankName'), data.bank], [t('pay.bankBranch'), data.bank_branch]]
        : [[t('pay.bankName'), data.bank]];
      const shown = rows.filter((r): r is [string, string] => !!r[1]);
      return (
        <>
          <p className="text-sm text-ink2">{t('pay.howToBank')}</p>
          {shown.length > 0 ? shown.map(([label, value]) => <CopyRow key={label} label={label} value={value} />) : <p className="text-sm text-muted">{t('pay.noInstructions')}</p>}
        </>
      );
    }
    return <p className="text-sm text-ink2">{t(m === 'cash' ? 'pay.howToCash' : 'pay.otherHint')}</p>;
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          aria-describedby="how-to-pay-after"
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-lift sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-xl"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="text-lg font-bold">{t('pay.howToTitle')}</Dialog.Title>
            <Dialog.Close aria-label={t('common.close')} className="grid h-10 w-10 place-items-center rounded-md text-muted hover:bg-hover">
              <Icon d="M6 6l12 12M18 6L6 18" size={20} />
            </Dialog.Close>
          </div>
          {instructions.error ? (
            <LoadError error={instructions.error} onRetry={() => void instructions.refetch()} />
          ) : !data ? (
            <ListSkeleton rows={3} />
          ) : (
            <div className="space-y-3">
              {methods.map((m) => (
                <section key={m} className="space-y-2 rounded-md border border-border p-3">
                  <h3 className="font-bold">{PAYMENT_METHOD_LABELS[m].bn}</h3>
                  {section(m)}
                </section>
              ))}
            </div>
          )}
          <p id="how-to-pay-after" className="mt-3 text-sm text-muted">{t('pay.howToAfter')}</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-soft px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{label}</span>
        <span className="select-all break-all text-lead font-bold tracking-wide">{value}</span>
      </span>
      <CopyButton text={value} />
    </div>
  );
}

const toAscii = (v: string): string => v.replace(/[০-৯]/g, (c) => String(c.charCodeAt(0) - 0x09e6));

function PickRow({ checked, partial, disabled, onToggle, title, sub, subBad, amount, status }: {
  checked: boolean;
  /** The typed amount reaches this row but does not pay it in full. */
  partial?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  title: string;
  sub?: string;
  subBad?: boolean;
  amount: string;
  status: string;
}) {
  return (
    <li>
      <label className={`flex min-h-16 items-center gap-3 px-4 py-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : checked ? 'cursor-pointer bg-accent-soft' : partial ? 'cursor-pointer bg-warn-bg' : 'cursor-pointer hover:bg-hover'}`}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="h-5 w-5 shrink-0 accent-[var(--accent-fill)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-body font-semibold">{title}</span>
          {sub && <span className={`block text-xs ${partial ? 'font-semibold text-warn' : subBad ? 'font-semibold text-bad' : 'text-muted'}`}>{sub}</span>}
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="text-base font-bold">{amount}</span>
          <StatusPill status={status} />
        </span>
      </label>
    </li>
  );
}

/** Newest payments first: a short list to start with, then a page at a time on "আরও দেখুন". */
const HISTORY_FIRST = 5;
const HISTORY_MORE = 10;

function History({ memberId }: { memberId: string | undefined }) {
  const { t } = useTranslation();
  // Folded until asked for: the page is for sending money, the history is looked at now and then.
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const q = useInfiniteQuery({
    queryKey: ['payments', 'me', memberId],
    enabled: !!memberId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<PaymentRow>>(`/payments?member_id=${memberId}&limit=${pageParam ? `${HISTORY_MORE}&cursor=${pageParam}` : HISTORY_FIRST}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="rounded-lg border border-border bg-card">
      <h3 className="text-lg font-bold leading-7">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} className={`flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-hover ${open ? 'rounded-t-lg border-b border-border' : 'rounded-lg'}`}>
          <span className="min-w-0 flex-1">{t('pay.history')}</span>
          <Icon d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} size={22} sw={2} />
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className="px-4 pb-4 pt-1">
        {q.error ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <ListSkeleton rows={3} />
        ) : items.length === 0 ? (
          <Empty text={t('pay.noHistory')} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((p) => (
              <PaymentItem key={p.id} p={p} />
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <button type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} className="btn btn-secondary mt-3 w-full text-foreground">
            {t('common.loadMore')}
          </button>
        )}
      </div>
    </section>
  );
}

function PaymentItem({ p }: { p: PaymentRow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detail = useQuery({ queryKey: ['payment', p.id], enabled: open, queryFn: () => api<PaymentDetail>(`/payments/${p.id}`) });

  return (
    <li className="py-2">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>
          <span className="block text-body font-semibold">{taka(p.amount_paisa)}</span>
          <span className="block text-sm text-muted">
            {PAYMENT_METHOD_LABELS[p.method].bn} · {fmtInstant(p.paid_at)}
          </span>
        </span>
        <StatusPill status={p.status} />
      </button>
      {open && (
        <div className="mt-2 space-y-1 rounded-md bg-soft p-3 text-sm">
          {p.trx_id && <p>{t('payment.trxId')}: <span className="select-all">{p.trx_id}</span></p>}
          {p.status === 'rejected' && p.reject_reason && <p className="text-bad">{t('pay.rejectedReason', { reason: p.reject_reason })}</p>}
          {p.status === 'confirmed' && (
            <>
              <p className="font-medium">{t('pay.receipt')}</p>
              {detail.isLoading && <ListSkeleton rows={1} />}
              {detail.data?.allocations.map((a, i) => (
                <p key={i}>
                  {a.due_id ? `${t(`pay.dueKind.${a.due_kind ?? 'monthly'}`)} · ${a.period ? fmtPeriod(a.period) : ''}` : t('pay.fineAllocated')}: {taka(a.amount_paisa)}
                </p>
              ))}
              {detail.data && BigInt(detail.data.unallocated_paisa) > 0n && <p>{t('pay.credit')}: {taka(detail.data.unallocated_paisa)}</p>}
            </>
          )}
        </div>
      )}
    </li>
  );
}
