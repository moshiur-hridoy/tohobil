import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { CopyButton } from '../../components/CopyButton';
import { ListSkeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayToIso, fmtDate, fmtInstant, fmtPeriod, todayDhaka } from '../../lib/dates';
import { parseAmountInput, taka } from '../../lib/money';
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
      <div className="space-y-4 p-4">
        <h2 className="text-lg font-semibold">{t('payment.title')}</h2>

        <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="pay-owed">
          <h3 id="pay-owed" className="mb-2 font-medium">{t('pay.duesAndFines')}</h3>
          {dues.error ? (
            <LoadError error={dues.error} onRetry={() => void dues.refetch()} />
          ) : !dues.data || !fines.data ? (
            <ListSkeleton rows={2} />
          ) : openDues.length + openFines.length === 0 ? (
            <p className="text-muted">{t('pay.noDues')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {openDues.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    {t(`pay.dueKind.${d.kind}`)} · {fmtPeriod(d.period)}
                    <span className="block text-sm text-muted">{t('pay.dueDate', { date: fmtDate(d.due_date) })}</span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold">{taka(d.outstanding_paisa)}</span>
                    <StatusPill status={d.under_verification ? 'pending' : d.status} />
                  </span>
                </li>
              ))}
              {openFines.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                  <span>{t('pay.fineLabel')}{f.period ? ` · ${fmtPeriod(f.period)}` : ''}</span>
                  <span className="font-semibold text-warn">{taka(f.outstanding_paisa)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <HowToPay />
        <SendMoneyForm
          periods={[...new Set(openDues.filter((d) => d.kind !== 'levy').map((d) => d.period))]}
          levyPeriods={[...new Set(openDues.filter((d) => d.kind === 'levy').map((d) => d.period))]}
          onSent={() => void refresh()}
        />
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
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-2 font-medium">{t('pay.howToPay')}</h3>
      {q.error ? (
        <LoadError error={q.error} />
      ) : q.data && rows.length === 0 ? (
        <p className="text-muted">{t('pay.noInstructions')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((k) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm text-muted">{PAYMENT_METHOD_LABELS[k].bn}</span>
                <span className="select-all break-all font-medium">{q.data?.[k]}</span>
              </span>
              <CopyButton text={q.data?.[k] ?? ''} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SendMoneyForm({ periods, levyPeriods, onSent }: { periods: string[]; levyPeriods: string[]; onSent: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bkash');
  const [trx, setTrx] = useState('');
  const [date, setDate] = useState(todayDhaka());
  const [period, setPeriod] = useState('');
  const [purpose, setPurpose] = useState<'dues' | 'levy'>('dues');
  const [file, setFile] = useState<File | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [done, setDone] = useState(false);
  // One key per attempt, so a retry after a dropped connection can never create a second payment.
  const attemptKey = useRef(crypto.randomUUID());

  const paisa = parseAmountInput(amount);
  const trxNeeded = NEEDS_TRX.includes(method);
  const readOnly = !!me?.read_only;

  const review = () => {
    setDone(false);
    if (!paisa) return setInvalid(t('pay.invalidAmount'));
    if (date > todayDhaka()) return setInvalid(t('pay.invalidDate'));
    if (trxNeeded && !trx.trim()) return setInvalid(t('errors.payment.trx_required'));
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
        paid_at: dayToIso(date),
        ...(purpose === 'levy' ? { purpose } : {}),
        ...(period ? { for_periods: [period] } : {}),
        ...(proof ? { proof_file_id: proof } : {}),
      },
    });
    setAmount('');
    setTrx('');
    setPeriod('');
    setPurpose('dues');
    setFile(null);
    setDone(true);
    onSent();
  };

  const field = 'h-12 w-full rounded-md border border-input bg-background px-3';

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="pay-send">
      <h3 id="pay-send" className="mb-3 font-medium">{t('pay.iSentMoney')}</h3>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
      >
        <label className="block">
          <span className="text-sm text-muted">{t('pay.amountLabel')}</span>
          <input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="amount-hint" />
          <span id="amount-hint" className="text-sm text-muted">{t('pay.amountHint')}</span>
        </label>

        <label className="block">
          <span className="text-sm text-muted">{t('payment.method')}</span>
          <select className={field} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m].bn}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm text-muted">{t('payment.trxId')}</span>
          <input className={field} value={trx} onChange={(e) => setTrx(e.target.value)} autoCapitalize="characters" autoComplete="off" disabled={!trxNeeded && method === 'cash'} />
          <span className="text-sm text-muted">{trxNeeded ? t('pay.trxHint') : t('pay.trxNotNeeded')}</span>
        </label>

        <label className="block">
          <span className="text-sm text-muted">{t('payment.date')}</span>
          <input className={field} type="date" value={date} max={todayDhaka()} onChange={(e) => setDate(e.target.value)} />
        </label>

        {levyPeriods.length > 0 && (
          <label className="block">
            <span className="text-sm text-muted">{t('pay.purposeLabel')}</span>
            <select className={field} value={purpose} onChange={(e) => { setPurpose(e.target.value as 'dues' | 'levy'); setPeriod(''); }}>
              <option value="dues">{t('pay.purposeDues')}</option>
              <option value="levy">{t('pay.purposeLevy')}</option>
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-sm text-muted">{t('pay.periodHint')}</span>
          <select className={field} value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">{t('pay.periodAny')}</option>
            {(purpose === 'levy' ? levyPeriods : periods).map((p) => (
              <option key={p} value={p}>{fmtPeriod(p)}</option>
            ))}
          </select>
        </label>

        <div>
          <span className="text-sm text-muted">{t('pay.screenshotLabel')}</span>
          <input type="file" aria-label={t('pay.screenshotLabel')} accept="image/jpeg,image/png,image/webp,application/pdf" className="mt-1 block w-full" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file && (
            <p className="mt-1 text-sm">
              {t('pay.screenshotAttached', { name: file.name })}{' '}
              <button type="button" className="underline" onClick={() => setFile(null)}>{t('pay.removeFile')}</button>
            </p>
          )}
        </div>

        {invalid && <p role="alert" className="text-bad">{invalid}</p>}
        {done && <p role="status" className="text-ok">{t('pay.sent')}</p>}

        <button type="submit" disabled={readOnly} className="h-12 w-full rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
          {t('pay.send')}
        </button>
        {readOnly && <p className="text-warn">{t('errors.auth.read_only')}</p>}
      </form>

      <ConfirmSheet open={sheet} onClose={() => setSheet(false)} title={t('pay.reviewTitle')} confirmLabel={t('pay.send')} onConfirm={send}>
        <SheetRow label={t('payment.amount')} value={paisa ? taka(paisa) : ''} strong />
        <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
        {trx.trim() && <SheetRow label={t('payment.trxId')} value={<span className="select-all">{trx.trim()}</span>} />}
        <SheetRow label={t('payment.date')} value={fmtDate(date)} />
        {period && <SheetRow label={t('payment.period')} value={fmtPeriod(period)} />}
        <p className="pt-2 text-muted">{t('pay.reviewBody')}</p>
      </ConfirmSheet>
    </section>
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
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-2 font-medium">{t('pay.history')}</h3>
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
        <button type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} className="mt-3 h-11 w-full rounded-md border border-border">
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
          <span className="block font-medium">{taka(p.amount_paisa)}</span>
          <span className="block text-sm text-muted">
            {PAYMENT_METHOD_LABELS[p.method].bn} · {fmtInstant(p.paid_at)}
          </span>
        </span>
        <StatusPill status={p.status} />
      </button>
      {open && (
        <div className="mt-2 space-y-1 rounded-md bg-background p-3 text-sm">
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
