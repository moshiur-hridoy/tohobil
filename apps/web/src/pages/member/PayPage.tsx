import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
import { useAuth } from '../../lib/auth';
import { dayToIso, fmtDate, fmtInstant, fmtPeriod, todayDhaka } from '../../lib/dates';
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

  // A month's fine is shown (and paid) together with that month's due.
  const fineOfPeriod = (period: string): bigint =>
    openFines.filter((f) => f.period === period).reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
  const firstDueOfPeriod = (d: DueRow): boolean => d.kind !== 'levy' && openDues.find((x) => x.kind !== 'levy' && x.period === d.period) === d;

  return (
    <PullToRefresh onRefresh={refresh}>
      <PageHeader title={t('payment.title')} subtitle={t('pay.subtitle')} />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-2">

        <section className="rounded-[20px] border border-border bg-card p-4" aria-labelledby="pay-owed">
          <h3 id="pay-owed" className="mb-2 text-base font-bold">{t('pay.duesAndFines')}</h3>
          {dues.error ? (
            <LoadError error={dues.error} onRetry={() => void dues.refetch()} />
          ) : !dues.data || !fines.data ? (
            <ListSkeleton rows={2} />
          ) : openDues.length + openFines.length === 0 ? (
            <p className="text-muted">{t('pay.noDues')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {openDues.map((d) => {
                const fine = firstDueOfPeriod(d) ? fineOfPeriod(d.period) : 0n;
                return (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                    <span>
                      {t(`pay.dueKind.${d.kind}`)} · {fmtPeriod(d.period)}
                      <span className="block text-sm text-muted">{t('pay.dueDate', { date: fmtDate(d.due_date) })}</span>
                      {fine > 0n && <span className="block text-sm font-semibold text-bad">{t('pay.fineLabel')}: {taka(fine)}</span>}
                    </span>
                    <span className="text-right">
                      <span className="block text-lg font-bold">{taka(d.outstanding_paisa)}</span>
                      <StatusPill status={d.under_verification ? 'pending' : d.status} />
                    </span>
                  </li>
                );
              })}
              {openFines.filter((f) => !f.period || !openDues.some((d) => d.kind !== 'levy' && d.period === f.period)).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                  <span>{t('pay.fineLabel')}{f.period ? ` · ${fmtPeriod(f.period)}` : ''}</span>
                  <span className="font-semibold text-bad">{taka(f.outstanding_paisa)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <HowToPay />
        <SendMoneyForm openDues={openDues} openFines={openFines} onSent={() => void refresh()} />
        <History memberId={me?.member_id} />
      </div>
    </PullToRefresh>
  );
}

function HowToPay() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['payment-instructions'], queryFn: () => api<PaymentInstructions>('/settings/payment-instructions'), staleTime: 5 * 60_000 });
  const rows = (['bkash', 'nagad', 'bank'] as const).filter((k) => q.data?.[k]);
  return (
    <details className="group rounded-[20px] border border-border bg-card p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-base font-bold [&::-webkit-details-marker]:hidden">
        {t('pay.howToPay')}
        <span className="transition-transform group-open:rotate-180"><Icon d="M6 9l6 6 6-6" size={20} sw={2} /></span>
      </summary>
      <div className="mt-2.5">
      {q.error ? (
        <LoadError error={q.error} />
      ) : q.data && rows.length === 0 ? (
        <p className="text-muted">{t('pay.noInstructions')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((k) => (
            <li key={k} className="flex items-center gap-3 rounded-[14px] bg-background px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted">{PAYMENT_METHOD_LABELS[k].bn}</span>
                <span className="select-all break-all text-[1.0625rem] font-bold tracking-wide">{q.data?.[k]}</span>
              </span>
              <CopyButton text={q.data?.[k] ?? ''} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2.5 text-xs leading-relaxed text-ink2">{t('pay.afterSendHint')}</p>
      </div>
    </details>
  );
}

/**
 * The member never types an amount: they tick what they are paying for and the total is worked out
 * from the dues, so a mistyped figure (or one that includes the bKash charge) cannot unbalance the books.
 */
function SendMoneyForm({ openDues, openFines, onSent }: { openDues: DueRow[]; openFines: FineRow[]; onSent: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<PaymentMethod>('bkash');
  const [trx, setTrx] = useState('');
  const [digits, setDigits] = useState('');
  const [date, setDate] = useState(todayDhaka());
  const [purpose, setPurpose] = useState<'dues' | 'levy'>('dues');
  const [file, setFile] = useState<File | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [done, setDone] = useState(false);
  // One key per attempt, so a retry after a dropped connection can never create a second payment.
  const attemptKey = useRef(crypto.randomUUID());

  const hasLevy = openDues.some((d) => d.kind === 'levy');
  const dues = openDues.filter((d) => (purpose === 'levy' ? d.kind === 'levy' : d.kind !== 'levy'));
  const fines = purpose === 'dues' ? openFines : [];
  const key = (kind: 'd' | 'f', id: string) => `${kind}:${id}`;
  const toggle = (k: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // A month's fine is paid together with that month: ticking the month adds its fine to the total.
  const duePeriods = new Set(dues.map((d) => d.period));
  const fineFor = (period: string): bigint =>
    fines.filter((f) => f.period === period).reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
  const looseFines = fines.filter((f) => !f.period || !duePeriods.has(f.period));

  const chosenDues = dues.filter((d) => picked.has(key('d', d.id)));
  const chosenPeriods = [...new Set(chosenDues.map((d) => d.period))];
  const chosenLoose = looseFines.filter((f) => picked.has(key('f', f.id)));
  const total =
    chosenDues.reduce((sum, d) => sum + BigInt(d.outstanding_paisa), 0n) +
    chosenPeriods.reduce((sum, p) => sum + fineFor(p), 0n) +
    chosenLoose.reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
  const fineTotal = chosenPeriods.reduce((sum, p) => sum + fineFor(p), 0n) + chosenLoose.reduce((sum, f) => sum + BigInt(f.outstanding_paisa), 0n);
  const periods = chosenPeriods;

  // Bengali digits are accepted and turned into 0-9; exactly four are kept as the sender's identity.
  const senderDigits = /^\d{4}$/.test(toAscii(digits.trim())) ? toAscii(digits.trim()) : '';
  const paisa = total > 0n ? total.toString() : null;
  const trxNeeded = NEEDS_TRX.includes(method);
  const readOnly = !!me?.read_only;

  const review = () => {
    setDone(false);
    if (!paisa) return setInvalid(t('pay.pickSomething'));
    if (date > todayDhaka()) return setInvalid(t('pay.invalidDate'));
    if (trxNeeded && !trx.trim() && !senderDigits) return setInvalid(t('errors.payment.trx_required'));
    if (digits.trim() && !senderDigits) return setInvalid(t('pay.senderDigitsInvalid'));
    setInvalid(null);
    attemptKey.current = crypto.randomUUID();
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
        ...(purpose === 'levy' ? { purpose } : {}),
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
    onSent();
  };

  const field = 'mt-1.5 h-[52px] w-full rounded-[14px] border-[1.5px] border-input bg-card px-3.5 text-base';
  const label = 'text-[0.8125rem] text-ink2';

  return (
    <section className="rounded-[20px] border border-border bg-card p-4" aria-labelledby="pay-send">
      <h3 id="pay-send" className="mb-3 text-base font-bold">{t('pay.iSentMoney')}</h3>
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
      >
        {hasLevy && (
          <label className="block">
            <span className={label}>{t('pay.purposeLabel')}</span>
            <select className={field} value={purpose} onChange={(e) => { setPurpose(e.target.value as 'dues' | 'levy'); setPicked(new Set()); }}>
              <option value="dues">{t('pay.purposeDues')}</option>
              <option value="levy">{t('pay.purposeLevy')}</option>
            </select>
          </label>
        )}

        <fieldset>
          <legend className={label}>{t('pay.whichMonths')}</legend>
          <ul className="mt-1.5 space-y-2">
            {dues.map((d) => {
              const fine = d.kind === 'levy' || dues.find((x) => x.period === d.period) !== d ? 0n : fineFor(d.period);
              return (
                <PickRow
                  key={d.id}
                  checked={picked.has(key('d', d.id))}
                  onToggle={() => toggle(key('d', d.id))}
                  title={`${t(`pay.dueKind.${d.kind}`)} · ${fmtPeriod(d.period)}`}
                  amount={taka(BigInt(d.outstanding_paisa) + fine)}
                  detail={fine > 0n ? t('pay.withFine', { due: taka(d.outstanding_paisa), fine: taka(fine) }) : undefined}
                />
              );
            })}
            {looseFines.map((f) => (
              <PickRow
                key={f.id}
                checked={picked.has(key('f', f.id))}
                onToggle={() => toggle(key('f', f.id))}
                title={`${t('pay.fineLabel')}${f.period ? ` · ${fmtPeriod(f.period)}` : ''}`}
                amount={taka(f.outstanding_paisa)}
              />
            ))}
          </ul>
        </fieldset>

        <div className="rounded-2xl bg-primary-soft p-4" aria-live="polite">
          <p className="text-[0.8125rem] text-ink2">{t('pay.payableTotal')}</p>
          <p data-testid="pay-total" className="text-[1.75rem] font-bold leading-tight text-primary">{taka(total)}</p>
          {fineTotal > 0n && (
            <p className="mt-1 text-sm font-semibold text-bad">{t('pay.totalIncludesFine', { fine: taka(fineTotal), due: taka(total - fineTotal) })}</p>
          )}
        </div>

        <div role="radiogroup" aria-label={t('payment.method')}>
          <span className={label}>{t('payment.method')}</span>
          <div className="mt-1.5 grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-2">
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
        </div>

        {trxNeeded && (
          <label className="block">
            <span className={label}>{t(method === 'bank' ? 'pay.senderDigitsBank' : 'pay.senderDigitsPhone')}</span>
            <input className={field} inputMode="numeric" maxLength={8} value={digits} onChange={(e) => setDigits(e.target.value)} autoComplete="off" aria-describedby="digits-hint" />
            <span id="digits-hint" className="text-sm text-muted">{t('pay.senderDigitsHint')}</span>
          </label>
        )}

        <label className="block">
          <span className={label}>{t('payment.trxId')} ({t('common.optional')})</span>
          <input className={field} value={trx} onChange={(e) => setTrx(e.target.value)} autoCapitalize="characters" autoComplete="off" disabled={!trxNeeded} />
          <span className="text-sm text-muted">{trxNeeded ? t('pay.trxHintOptional') : t('pay.trxNotNeeded')}</span>
        </label>

        <label className="block">
          <span className={label}>{t('payment.date')}</span>
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

        {invalid && <p role="alert" className="text-bad">{invalid}</p>}
        {done && <p role="status" className="text-ok">{t('pay.sent')}</p>}

        <button type="submit" disabled={readOnly} className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-[1.0625rem] font-bold text-primary-foreground disabled:opacity-50">
          {t('pay.send')}
        </button>
        {readOnly && <p className="text-warn">{t('errors.auth.read_only')}</p>}
      </form>

      <ConfirmSheet open={sheet} onClose={() => setSheet(false)} title={t('pay.reviewTitle')} confirmLabel={t('pay.send')} onConfirm={send}>
        <SheetRow label={t('payment.amount')} value={paisa ? taka(paisa) : ''} strong />
        <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
        {trx.trim() && <SheetRow label={t('payment.trxId')} value={<span className="select-all">{trx.trim()}</span>} />}
        {senderDigits && <SheetRow label={t(method === 'bank' ? 'pay.senderDigitsBank' : 'pay.senderDigitsPhone')} value={senderDigits} />}
        <SheetRow label={t('payment.date')} value={fmtDate(date)} />
        {periods.length > 0 && <SheetRow label={t('payment.period')} value={periods.map(fmtPeriod).join(', ')} />}
        <p className="pt-2 text-muted">{t('pay.reviewBody')}</p>
      </ConfirmSheet>
    </section>
  );
}

const toAscii = (v: string): string => v.replace(/[০-৯]/g, (c) => String(c.charCodeAt(0) - 0x09e6));

function PickRow({ checked, onToggle, title, amount, detail }: { checked: boolean; onToggle: () => void; title: string; amount: string; detail?: string | undefined }) {
  return (
    <li>
      <label className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-[14px] border-[1.5px] px-3.5 py-2 ${checked ? 'border-primary bg-primary-soft' : 'border-border bg-card'}`}>
        <input type="checkbox" checked={checked} onChange={onToggle} className="h-5 w-5 shrink-0 accent-[var(--primary)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9375rem] font-medium">{title}</span>
          {detail && <span className="block text-xs font-semibold text-bad">{detail}</span>}
        </span>
        <span className="text-base font-bold">{amount}</span>
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
