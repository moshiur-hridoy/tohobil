import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@barakah/shared';
import { ConfirmSheet, SheetRow } from '../../../components/ConfirmSheet';
import { api } from '../../../lib/api';
import { uuid } from '../../../lib/uuid';
import { errorMessage } from '../../../lib/errors';
import { dayToIso, fmtDate, fmtPeriod, todayDhaka } from '../../../lib/dates';
import { paisaToDecimal, parseAmountInput, taka } from '../../../lib/money';
import { formatCount } from '../../../lib/format';
import type { MemberRow, ParsedSms, PaymentInstructions } from '../../../lib/types';
import { DateInput, Optional } from '../../../components/ui';
import { StatusPill } from '../../../components/StatusPill';
import { MAX_AHEAD, allocationsFor, entryRows, pickedTotal, togglePick, type EntryPreview, type EntryRow } from './entryRows';

type Purpose = 'dues' | 'special' | 'levy' | 'entry';
const PURPOSE_LABEL: Record<Purpose, string> = {
  dues: 'pay.purposeDues',
  special: 'pay.purposeSpecial',
  levy: 'pay.purposeLevy',
  entry: 'paymentsPage.purposeEntry',
};

interface EntryQuote {
  shares: number;
  price_paisa: string;
  paid_paisa: string;
  outstanding_paisa: string;
  pay_by: string;
  expired: boolean;
}

export interface EntryPrefill {
  parsed?: ParsedSms;
  rawSms?: string;
}

/**
 * Cashier entry: create and confirm a payment in one step (spec 5.4). Used for cash taken in hand
 * and for a pasted SMS. The summary names the effect; nothing is posted until the server answers.
 * A prospective member can only pay their entry price, within the quote's days; once it has lapsed
 * the cashier makes a new quote at today's price first (5.9). A member with an open special
 * contribution or levy picks what the money is for, so it never lands on the monthly dues.
 */
export function EntrySheet({ open, onClose, prefill, onDone }: { open: boolean; onClose: () => void; prefill: EntryPrefill | null; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  // Same list the settings page gives members; a method that came in from a pasted SMS stays pickable.
  const instructions = useQuery({ queryKey: ['payment-instructions'], queryFn: () => api<PaymentInstructions>('/settings/payment-instructions'), staleTime: 5 * 60_000 });
  const enabled = instructions.data?.methods?.length ? instructions.data.methods : PAYMENT_METHODS;
  const methodChoices = PAYMENT_METHODS.filter((m) => enabled.includes(m) || m === method);
  const [trx, setTrx] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayDhaka());
  const [purpose, setPurpose] = useState<Purpose>('dues');
  const [requoteError, setRequoteError] = useState<unknown>(null);
  const [requoting, setRequoting] = useState(false);
  // Rows the cashier ticked one by one; null while the typed amount simply fills the rows top down.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const key = useRef(uuid());

  useEffect(() => {
    if (!open) return;
    key.current = uuid();
    const p = prefill?.parsed;
    const byPhone = p?.counterparty_phone ? members.data?.items.find((m) => m.phone === p.counterparty_phone && m.status !== 'exited' && m.status !== 'deceased')?.id : undefined;
    const byMatch = p?.matches.find((m) => m.exact)?.member_id ?? p?.matches[0]?.member_id;
    setMemberId(byMatch ?? byPhone ?? '');
    setAmount(p?.amount_paisa ? paisaToDecimal(p.amount_paisa) : '');
    setMethod(p?.method ?? 'cash');
    setTrx(p?.trx_id ?? '');
    setNote('');
    setDate(p?.paid_at ? p.paid_at.slice(0, 10) : todayDhaka());
    setPicked(null);
  }, [open, prefill, members.data]);

  const member = members.data?.items.find((m) => m.id === memberId);
  const prospective = member?.status === 'prospective';
  const detail = useQuery({
    queryKey: ['member', memberId],
    queryFn: () => api<{ dues: Array<{ kind: string; outstanding_paisa: string }> }>(`/members/${memberId}`),
    enabled: open && !!memberId && !prospective,
  });
  const quote = useQuery({
    queryKey: ['entry-quote', memberId],
    queryFn: () => api<{ quote: EntryQuote | null }>(`/members/${memberId}/entry-quote`),
    enabled: open && prospective,
  });
  const q = quote.data?.quote ?? null;

  const purposes: Purpose[] = prospective
    ? ['entry']
    : ['dues', ...(['special', 'levy'] as const).filter((k) => detail.data?.dues.some((d) => d.kind === k && BigInt(d.outstanding_paisa) > 0n))];
  useEffect(() => {
    setPurpose(prospective ? 'entry' : 'dues');
    setRequoteError(null);
    setPicked(null);
  }, [memberId, prospective]);
  // The entry price is not typed: it is what the quote still asks for.
  useEffect(() => {
    if (purpose === 'entry' && q && !q.expired && !prefill?.parsed?.amount_paisa) setAmount(paisaToDecimal(q.outstanding_paisa));
  }, [purpose, q, prefill]);

  const requote = async () => {
    setRequoting(true);
    setRequoteError(null);
    try {
      await api(`/members/${memberId}/entry-quote`, { method: 'POST', body: {} });
      await quote.refetch();
    } catch (err) {
      setRequoteError(err);
    } finally {
      setRequoting(false);
    }
  };

  const paisa = parseAmountInput(amount);
  // The member's open months, filled with the typed amount in the order the server will pay them.
  const preview = useQuery({
    queryKey: ['entry-preview', memberId, purpose],
    queryFn: () => api<EntryPreview>(`/payments/entry-preview?member_id=${memberId}&purpose=${purpose}`),
    enabled: open && !!memberId && !prospective && purpose !== 'entry',
  });
  const fill = preview.data && purpose !== 'entry' ? entryRows(preview.data, BigInt(paisa ?? '0'), todayDhaka(), picked) : null;
  const allocations = fill ? allocationsFor(fill.rows) : [];
  const tap = (rowKey: string) => {
    if (!fill) return;
    const next = togglePick(fill.rows, picked, rowKey);
    setPicked(next);
    setAmount(paisaToDecimal(pickedTotal(fill.rows, next)));
  };
  const aheadPaid = fill?.rows.reduce((s, r) => s + (r.status === 'advance' ? r.covered : 0n), 0n) ?? 0n;
  const forPeriods = [...new Set(fill?.rows.flatMap((r) => (r.covered > 0n && r.period ? [r.period] : [])) ?? [])];
  const needsTrx = method === 'bkash' || method === 'nagad' || method === 'bank';
  const entryBlocked = purpose === 'entry' && (!q || date > q.pay_by);
  const valid = !!paisa && !!memberId && date <= todayDhaka() && (!needsTrx || trx.trim() !== '') && !entryBlocked;

  const submit = async () => {
    await api('/payments/cashier-entry', {
      method: 'POST',
      headers: { 'Idempotency-Key': key.current },
      body: {
        member_id: memberId,
        amount_paisa: paisa,
        method,
        ...(trx.trim() ? { trx_id: trx.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        paid_at: dayToIso(date),
        ...(purpose !== 'dues' ? { purpose } : {}),
        ...(forPeriods.length > 0 ? { for_periods: forPeriods.slice(0, 24) } : {}),
        // Exactly what the rows show, so a month's fine is paid with that month (ASSUMPTIONS 61).
        ...(allocations.length > 0 ? { allocations } : {}),
        ...(prefill?.rawSms ? { raw_sms: prefill.rawSms } : {}),
      },
    });
    await qc.invalidateQueries();
    onDone();
  };

  const field = 'field w-full';
  return (
    <ConfirmSheet open={open} onClose={onClose} title={t('paymentsPage.entryTitle')} confirmLabel={t('paymentsPage.entryRecord')} canConfirm={valid} onConfirm={submit}>
      <label className="field-label">
        {t('paymentsPage.entryMember')}
        <select className={field} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">{t('paymentsPage.entryChoose')}</option>
          {members.data?.items.map((m) => (
            <option key={m.id} value={m.id}>{m.code} {m.full_name}{m.status === 'prospective' ? ` · ${t('paymentsPage.prospective')}` : ''}</option>
          ))}
        </select>
      </label>
      {purposes.length > 1 && (
        <label className="field-label">
          {t('pay.purposeLabel')}
          <select className={field} value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
            {purposes.map((p) => (
              <option key={p} value={p}>{t(PURPOSE_LABEL[p])}</option>
            ))}
          </select>
        </label>
      )}
      {prospective && (
        <div className="rounded-md bg-background p-3 text-sm">
          {!q ? (
            <p className="text-muted">{quote.isLoading ? '…' : t('paymentsPage.noQuote')}</p>
          ) : (
            <>
              <SheetRow label={t('paymentsPage.quotePrice', { shares: q.shares })} value={taka(q.price_paisa)} />
              {BigInt(q.paid_paisa) > 0n && <SheetRow label={t('paymentsPage.quotePaid')} value={taka(q.paid_paisa)} />}
              <SheetRow label={t('paymentsPage.quoteLeft')} value={taka(q.outstanding_paisa)} strong />
              <SheetRow label={t('paymentsPage.quotePayBy')} value={fmtDate(q.pay_by)} />
              {q.expired ? (
                <div className="mt-2 space-y-2">
                  <p className="text-warn">{t('paymentsPage.quoteExpired')}</p>
                  <button type="button" disabled={requoting} onClick={() => void requote()} className="h-11 w-full rounded-md border border-border font-semibold text-primary">
                    {t('paymentsPage.requote')}
                  </button>
                  {requoteError != null && <p role="alert" className="text-bad">{errorMessage(t, requoteError).message}</p>}
                </div>
              ) : (
                date > q.pay_by && <p className="mt-2 text-warn">{t('paymentsPage.quoteDateLate')}</p>
              )}
            </>
          )}
        </div>
      )}
      <label className="field-label">
        {t('payment.amount')} (৳)
        <input
          className={field}
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setPicked(null);
          }}
        />
      </label>
      {fill && (
        <fieldset className="min-w-0">
          <legend className="text-sm font-semibold">{t('paymentsPage.entryRowsTitle')}</legend>
          {fill.rows.length === 0 ? (
            <p className="mt-1 text-sm text-muted">{t('paymentsPage.owedNothing')}</p>
          ) : (
            <>
              <p className="mb-1.5 text-xs text-muted">{t('paymentsPage.entryRowsHint')}</p>
              <ul className="space-y-1.5">
                {fill.rows.map((r) => (
                  <EntryRowCard key={r.key} row={r} onTap={() => tap(r.key)} />
                ))}
              </ul>
            </>
          )}
          {preview.data && preview.data.credit_paisa !== '0' && (
            <p className="mt-1.5 text-xs text-muted">{t('paymentsPage.creditHeld', { amount: taka(preview.data.credit_paisa) })}</p>
          )}
        </fieldset>
      )}
      <label className="field-label">
        {t('payment.method')}
        <select className={field} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {methodChoices.map((m) => (
            <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m].bn}</option>
          ))}
        </select>
      </label>
      <label className="field-label">
        {t('payment.trxId')}
        <input className={field} value={trx} onChange={(e) => setTrx(e.target.value)} autoComplete="off" />
      </label>
      <label className="field-label">
        {t('common.note')}
        <Optional />
        <textarea className={`${field} min-h-20`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('paymentsPage.entryNoteExample')} />
        <span className="mt-1 block text-xs font-normal text-muted">{t('paymentsPage.entryNoteHint')}</span>
      </label>
      <label className="field-label">
        {t('paymentsPage.entryPaidAt')}
        <DateInput className={field} max={todayDhaka()} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {valid && member && (
        <div className="rounded-md bg-background p-3">
          <SheetRow label={`${member.code} ${member.full_name}`} value={taka(paisa as string)} strong />
          {purpose !== 'dues' && <SheetRow label={t('pay.purposeLabel')} value={t(PURPOSE_LABEL[purpose])} />}
          <SheetRow label={t('payment.method')} value={PAYMENT_METHOD_LABELS[method].bn} />
          <SheetRow label={t('paymentsPage.paidAt')} value={fmtDate(date)} />
          {note.trim() && <p className="mt-1 whitespace-pre-line text-sm text-muted">{note.trim()}</p>}
        </div>
      )}
      {valid && fill && (aheadPaid > 0n || fill.leftover > 0n) && (
        <div role="alert" className="space-y-1 rounded-md border border-warn bg-warn-bg p-3 text-sm text-warn">
          {aheadPaid > 0n && <p>{t('paymentsPage.aheadWarn', { amount: taka(aheadPaid) })}</p>}
          {fill.leftover > 0n &&
            (preview.data?.monthly ? (
              <p>{t('paymentsPage.leftoverWarn', { months: formatCount(MAX_AHEAD), amount: taka(fill.leftover) })}</p>
            ) : (
              <p>{t(fill.rows.length === 0 ? 'paymentsPage.creditWarnAll' : 'paymentsPage.creditWarn', { amount: taka(fill.leftover) })}</p>
            ))}
        </div>
      )}
      <p className="text-warn">{t('paymentsPage.entryWarn')}</p>
    </ConfirmSheet>
  );
}

/**
 * One month (or fine) in the entry sheet, smaller than the pay page's card. Ticked when the amount
 * pays it in full; a part payment says how much lands and how much stays open. Tapping it sets the
 * row on or off and sets the amount to what the ticked rows cost (see `togglePick`).
 */
function EntryRowCard({ row, onTap }: { row: EntryRow; onTap: () => void }) {
  const { t } = useTranslation();
  const full = row.covered === row.need;
  const part = row.covered > 0n && !full;
  const title =
    row.kind === 'fine'
      ? `${t('pay.fineLabel')}${row.period ? ` · ${fmtPeriod(row.period)}` : ''}`
      : `${row.period ? fmtPeriod(row.period) : ''}${row.kind !== 'monthly' ? ` · ${t(`pay.dueKind.${row.kind}`)}` : ''}`;
  return (
    <li>
      <label className={`flex min-h-12 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-1.5 ${full ? 'border-primary bg-primary-soft' : part ? 'border-warn bg-warn-bg' : 'border-border bg-card'}`}>
        <input type="checkbox" checked={full} onChange={onTap} className="h-[18px] w-[18px] shrink-0 accent-[var(--primary)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          {part ? (
            <span className="block text-xs font-semibold text-warn">{t('paymentsPage.entryPartial', { paid: taka(row.covered), left: taka(row.need - row.covered) })}</span>
          ) : (
            row.dueDate && <span className="block text-xs text-muted">{t('pay.dueDate', { date: fmtDate(row.dueDate) })}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-sm font-bold">{taka(row.need)}</span>
          <StatusPill status={row.status} />
        </span>
      </label>
    </li>
  );
}
