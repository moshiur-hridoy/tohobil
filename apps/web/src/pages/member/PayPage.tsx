import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@barakah/shared';
import { Icon, PageHeader } from '../../components/ui';
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
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';
import type { DueRow, FineRow, Page, PaymentDetail, PaymentInstructions, PaymentRow } from '../../lib/types';

const NEEDS_TRX: PaymentMethod[] = ['bkash', 'nagad', 'bank'];

export function PayPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();

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
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['dues'] }), qc.invalidateQueries({ queryKey: ['fines'] }), qc.invalidateQueries({ queryKey: ['payments'] }), qc.invalidateQueries({ queryKey: ['members'] })]);

  const openDues = (dues.data?.items ?? []).filter((d) => BigInt(d.outstanding_paisa) > 0n).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const openFines = (fines.data?.items ?? []).filter((f) => BigInt(f.outstanding_paisa) > 0n && f.status !== 'waived');

  return (
    <PullToRefresh onRefresh={refresh}>
      <PageHeader title={t('payment.title')} subtitle={t('pay.subtitle')} />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-2">
        {dues.error ? (
          <LoadError error={dues.error} onRetry={() => void dues.refetch()} />
        ) : fines.error ? (
          <LoadError error={fines.error} onRetry={() => void fines.refetch()} />
        ) : !dues.data || !fines.data ? (
          <div className="rounded-[20px] border border-border bg-card p-4"><ListSkeleton rows={3} /></div>
        ) : (
          // Mounted once the dues are in, so the default ticks see them. Not re-keyed on refresh: coming
          // back from the bKash app refetches, and that must not wipe what the member has typed.
          <SendMoneyForm openDues={openDues} openFines={openFines} onSent={() => void refresh()} />
        )}
        <History memberId={me?.member_id} />
      </div>
    </PullToRefresh>
  );
}

/** A numbered step: the page reads top to bottom as "what, how, then the details". */
function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-[20px] border border-border bg-card p-4" aria-labelledby={`pay-step-${n}`}>
      <div className="mb-3 flex items-start gap-3">
        <span aria-hidden="true" className="grid h-7 w-7 flex-none place-items-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{formatCount(n)}</span>
        <div className="min-w-0">
          <h2 id={`pay-step-${n}`} className="text-base font-bold leading-7">{title}</h2>
          {hint && <p className="text-[0.8125rem] leading-snug text-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

type Purpose = 'dues' | 'levy' | 'special';
const PURPOSES: readonly Purpose[] = ['dues', 'special', 'levy'];
const SEPARATE_KINDS = new Set<string>(['levy', 'special']);
const PURPOSE_LABEL: Record<Purpose, string> = { dues: 'pay.purposeDues', levy: 'pay.purposeLevy', special: 'pay.purposeSpecial' };

/**
 * The member never types an amount: they tick what they are paying for and the total is worked out
 * from the dues, so a mistyped figure (or one that includes the bKash charge) cannot unbalance the books.
 * Months are paid oldest first: ticking a month ticks every earlier one, unticking it unticks the later ones.
 */
function SendMoneyForm({ openDues, openFines, onSent }: { openDues: DueRow[]; openFines: FineRow[]; onSent: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const today = todayDhaka();
  const currentPeriod = today.slice(0, 7);
  const [purpose, setPurpose] = useState<Purpose>('dues');
  const [method, setMethod] = useState<PaymentMethod>('bkash');
  const [trx, setTrx] = useState('');
  const [digits, setDigits] = useState('');
  const [date, setDate] = useState(today);
  const [file, setFile] = useState<File | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  // The amount just sent: while set, a confirmation card tells the member it is with the cashier.
  const [sentAmount, setSentAmount] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // One key per attempt, so a retry after a dropped connection can never create a second payment.
  const attemptKey = useRef(uuid());

  const instructions = useQuery({ queryKey: ['payment-instructions'], queryFn: () => api<PaymentInstructions>('/settings/payment-instructions'), staleTime: 5 * 60_000 });

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
  const payable = months.filter((m) => !m.verifying);
  const looseFines = fines.filter((f) => !f.period || !months.some((m) => m.period === f.period));

  // Ticked by default: everything already due, so the usual case needs no decision at all.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set([...payable.filter((m) => m.dueDate <= today).map((m) => m.period), ...looseFines.map((f) => f.id)]),
  );
  const toggleMonth = (period: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const on = !prev.has(period);
      for (const m of payable) {
        if (on && m.period <= period) next.add(m.period);
        if (!on && m.period >= period) next.delete(m.period);
      }
      return next;
    });
  const toggleFine = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = payable.filter((m) => picked.has(m.period));
  const chosenLoose = looseFines.filter((f) => picked.has(f.id));
  const fineTotal = chosen.reduce((sum, m) => sum + m.fine, 0n) + chosenLoose.reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
  const total = chosen.reduce((sum, m) => sum + m.principal, 0n) + fineTotal;
  const periods = chosen.map((m) => m.period);

  // Bengali digits are accepted and turned into 0-9; exactly four are kept as the sender's identity.
  const senderDigits = /^\d{4}$/.test(toAscii(digits.trim())) ? toAscii(digits.trim()) : '';
  const paisa = total > 0n ? total.toString() : null;
  const trxNeeded = NEEDS_TRX.includes(method);
  const readOnly = !!me?.read_only;
  const account = method === 'bkash' || method === 'nagad' || method === 'bank' ? instructions.data?.[method] : undefined;

  const review = () => {
    setDone(false);
    if (!paisa) return setInvalid(t('pay.pickSomething'));
    if (date > todayDhaka()) return setInvalid(t('pay.invalidDate'));
    if (trxNeeded && !trx.trim() && !senderDigits) return setInvalid(t('errors.payment.trx_required'));
    if (digits.trim() && !senderDigits) return setInvalid(t('pay.senderDigitsInvalid'));
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
        ...(trx.trim() ? { trx_id: trx.trim() } : {}),
        ...(senderDigits ? { note: t(method === 'bank' ? 'pay.senderNoteBank' : 'pay.senderNotePhone', { digits: senderDigits }) } : {}),
        paid_at: dayToIso(date),
        ...(purpose !== 'dues' ? { purpose } : {}),
        ...(periods.length > 0 ? { for_periods: periods } : {}),
        ...(proof ? { proof_file_id: proof } : {}),
      },
    });
    setPicked(new Set());
    setTrx('');
    setDigits('');
    setPurpose('dues');
    setFile(null);
    setDone(true);
    setSentAmount(taka(paisa as string));
    window.scrollTo({ top: 0 });
    onSent();
  };

  const field = 'field field-lg mt-1.5 w-full';
  const label = 'text-[0.8125rem] text-ink2';

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <Step n={1} title={t('pay.step1')} hint={payable.length > 1 ? t('pay.step1Hint') : undefined}>
        {purposes.length > 1 && (
          <div role="radiogroup" aria-label={t('pay.purposeLabel')} className="mb-3 flex rounded-2xl border border-border bg-background p-1">
            {purposes.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={purpose === p}
                onClick={() => { setPurpose(p); setPicked(new Set()); }}
                className={`flex-1 rounded-xl py-2 text-sm font-bold ${purpose === p ? 'bg-primary-soft text-primary' : 'text-muted'}`}
              >
                {t(PURPOSE_LABEL[p])}
              </button>
            ))}
          </div>
        )}

        {months.length + looseFines.length === 0 ? (
          <p className="rounded-2xl bg-ok-bg p-4 text-center font-semibold text-ok">{t('pay.noDues')}</p>
        ) : (
          <fieldset>
            <legend className="sr-only">{t('pay.step1')}</legend>
            <ul className="space-y-2">
              {months.map((m) => {
                const kinds = [...new Set(m.list.map((d) => d.kind))].filter((k) => k !== 'monthly');
                return (
                  <PickRow
                    key={m.period}
                    checked={!m.verifying && picked.has(m.period)}
                    disabled={m.verifying}
                    onToggle={() => toggleMonth(m.period)}
                    title={`${fmtPeriod(m.period)}${kinds.length ? ` · ${kinds.map((k) => t(`pay.dueKind.${k}`)).join(', ')}` : ''}`}
                    sub={m.fine > 0n ? t('pay.withFine', { due: taka(m.principal), fine: taka(m.fine) }) : t('pay.dueDate', { date: fmtDate(m.dueDate) })}
                    subBad={m.fine > 0n}
                    amount={taka(m.principal + m.fine)}
                    status={m.verifying ? 'pending' : m.period > currentPeriod ? 'advance' : m.status}
                  />
                );
              })}
              {looseFines.map((f) => (
                <PickRow
                  key={f.id}
                  checked={picked.has(f.id)}
                  onToggle={() => toggleFine(f.id)}
                  title={`${t('pay.fineLabel')}${f.period ? ` · ${fmtPeriod(f.period)}` : ''}`}
                  amount={taka(f.outstanding_paisa)}
                  status="overdue"
                />
              ))}
            </ul>
          </fieldset>
        )}

        <div className="mt-3 flex items-end justify-between gap-3 rounded-2xl bg-primary-soft px-4 py-3" aria-live="polite">
          <div>
            <p className="text-[0.8125rem] text-ink2">{t('pay.payableTotal')}</p>
            {fineTotal > 0n && <p className="text-xs font-semibold text-bad">{t('pay.includesFine', { fine: taka(fineTotal) })}</p>}
          </div>
          <p data-testid="pay-total" className="text-[1.75rem] font-bold leading-tight text-primary">{taka(total)}</p>
        </div>
      </Step>

      <Step n={2} title={t('pay.step2')} hint={total > 0n ? t('pay.step2Hint', { amount: taka(total) }) : undefined}>
        <div role="radiogroup" aria-label={t('payment.method')} className="grid grid-cols-3 gap-2">
          {PAYMENT_METHODS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`h-12 rounded-[14px] border-[1.5px] text-sm ${method === m ? 'border-primary bg-primary-soft font-bold text-primary' : 'border-border bg-card text-ink2'}`}
            >
              {PAYMENT_METHOD_LABELS[m].bn}
            </button>
          ))}
        </div>
        <div className="mt-3">
          {!trxNeeded ? (
            <p className="rounded-[14px] bg-background px-3 py-3 text-sm text-ink2">{t(method === 'cash' ? 'pay.cashHint' : 'pay.otherHint')}</p>
          ) : instructions.error ? (
            <LoadError error={instructions.error} />
          ) : !instructions.data ? (
            <ListSkeleton rows={1} />
          ) : account ? (
            <div className="flex items-center gap-3 rounded-[14px] bg-background px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted">{t('pay.sendTo', { method: PAYMENT_METHOD_LABELS[method].bn })}</span>
                <span className="select-all break-all text-[1.0625rem] font-bold tracking-wide">{account}</span>
              </span>
              <CopyButton text={account} />
            </div>
          ) : (
            <p className="rounded-[14px] bg-background px-3 py-3 text-sm text-muted">{t('pay.noInstructions')}</p>
          )}
        </div>
      </Step>

      <Step n={3} title={t('pay.step3')} hint={t('pay.step3Hint')}>
        <div className="space-y-3.5">
          {trxNeeded && (
            <>
              <label className="block">
                <span className={label}>{t('payment.trxId')}</span>
                <input className={field} value={trx} onChange={(e) => setTrx(e.target.value)} autoCapitalize="characters" autoComplete="off" />
                <span className="text-sm text-muted">{t('pay.trxHintOptional')}</span>
              </label>
              <label className="block">
                <span className={label}>{t(method === 'bank' ? 'pay.senderDigitsBank' : 'pay.senderDigitsPhone')}</span>
                <input className={field} inputMode="numeric" maxLength={8} value={digits} onChange={(e) => setDigits(e.target.value)} autoComplete="off" aria-describedby="digits-hint" />
                <span id="digits-hint" className="text-sm text-muted">{t('pay.senderDigitsHint')}</span>
              </label>
            </>
          )}

          <label className="block">
            <span className={label}>{t('pay.sentOn')}</span>
            <input className={field} type="date" value={date} max={todayDhaka()} onChange={(e) => setDate(e.target.value)} />
          </label>

          <div>
            <span className={label}>{t('pay.screenshotLabel')}</span>
            <input type="file" aria-label={t('pay.screenshotLabel')} accept="image/jpeg,image/png,image/webp,application/pdf" className="mt-1.5 block w-full rounded-[14px] border-[1.5px] border-dashed border-input p-3 text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && (
              <p className="mt-1 text-sm">
                {t('pay.screenshotAttached', { name: file.name })}{' '}
                <button type="button" className="underline" onClick={() => setFile(null)}>{t('pay.removeFile')}</button>
              </p>
            )}
          </div>
        </div>
      </Step>

      {invalid && <p role="alert" className="px-1 text-bad">{invalid}</p>}
      {done && <p role="status" className="rounded-2xl bg-ok-bg p-3 text-ok">{t('pay.sent')}</p>}

      <button type="submit" disabled={readOnly} className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-[1.0625rem] font-bold text-primary-foreground disabled:opacity-50">
        {t('pay.send')}
        {total > 0n && <span>· {taka(total)}</span>}
      </button>
      {readOnly && <p className="text-warn">{t('errors.auth.read_only')}</p>}

      <Dialog.Root open={sentAmount !== null} onOpenChange={(o) => !o && setSentAmount(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content aria-describedby="pay-sent-body" className="fixed left-1/2 top-1/2 z-50 w-[min(24rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[24px] border border-border bg-card p-6 text-center shadow-lift">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-ok-bg text-ok"><Icon d="M5 12l5 5 9-10" size={28} sw={2.4} /></span>
            <Dialog.Title className="mt-4 text-lg font-bold">{t('pay.sentTitle')}</Dialog.Title>
            <p id="pay-sent-body" className="mt-2 text-ink2">{t('pay.sentBody', { amount: sentAmount ?? '' })}</p>
            <Dialog.Close className="mt-5 h-12 w-full rounded-2xl bg-primary font-bold text-primary-foreground">{t('pay.sentOk')}</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmSheet open={sheet} onClose={() => setSheet(false)} title={t('pay.reviewTitle')} confirmLabel={t('pay.send')} onConfirm={send}>
        <SheetRow label={t('payment.amount')} value={paisa ? taka(paisa) : ''} strong />
        <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
        {trx.trim() && <SheetRow label={t('payment.trxId')} value={<span className="select-all">{trx.trim()}</span>} />}
        {senderDigits && <SheetRow label={t(method === 'bank' ? 'pay.senderDigitsBank' : 'pay.senderDigitsPhone')} value={senderDigits} />}
        <SheetRow label={t('payment.date')} value={fmtDate(date)} />
        {periods.length > 0 && <SheetRow label={t('payment.period')} value={periods.map(fmtPeriod).join(', ')} />}
        <p className="pt-2 text-muted">{t('pay.reviewBody')}</p>
      </ConfirmSheet>
    </form>
  );
}

const toAscii = (v: string): string => v.replace(/[০-৯]/g, (c) => String(c.charCodeAt(0) - 0x09e6));

function PickRow({ checked, disabled, onToggle, title, sub, subBad, amount, status }: {
  checked: boolean;
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
      <label className={`flex min-h-16 items-center gap-3 rounded-[14px] border-[1.5px] px-3.5 py-2.5 ${disabled ? 'cursor-not-allowed border-border bg-card opacity-60' : checked ? 'cursor-pointer border-primary bg-primary-soft' : 'cursor-pointer border-border bg-card'}`}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="h-5 w-5 shrink-0 accent-[var(--primary)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9375rem] font-semibold">{title}</span>
          {sub && <span className={`block text-xs ${subBad ? 'font-semibold text-bad' : 'text-muted'}`}>{sub}</span>}
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="text-base font-bold">{amount}</span>
          <StatusPill status={status} />
        </span>
      </label>
    </li>
  );
}

function History({ memberId }: { memberId: string | undefined }) {
  const { t } = useTranslation();
  const q = useInfiniteQuery({
    queryKey: ['payments', 'me', memberId],
    enabled: !!memberId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<PaymentRow>>(`/payments?member_id=${memberId}&limit=20${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="rounded-[20px] border border-border bg-card p-4">
      <h3 className="mb-2 text-base font-bold">{t('pay.history')}</h3>
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
        <button type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} className="mt-3 h-11 w-full rounded-[14px] border border-border">
          {t('common.loadMore')}
        </button>
      )}
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
          <span className="block text-[0.9375rem] font-semibold">{taka(p.amount_paisa)}</span>
          <span className="block text-sm text-muted">
            {PAYMENT_METHOD_LABELS[p.method].bn} · {fmtInstant(p.paid_at)}
          </span>
        </span>
        <StatusPill status={p.status} />
      </button>
      {open && (
        <div className="mt-2 space-y-1 rounded-xl bg-background p-3 text-sm">
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
