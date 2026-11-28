import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { todayDhaka } from '../lib/dates';
import { parseAmountInput, taka } from '../lib/money';
import type { MandateRow } from '../lib/types';
import { ConfirmSheet } from './ConfirmSheet';
import { DateInput, Optional } from './ui';
import { FilePicker } from './FilePicker';

/** What may still go to the shop this month under `mandate`. */
export function mandateLeft(mandate: MandateRow): bigint {
  const rest = BigInt(mandate.monthly_max_paisa) - BigInt(mandate.used_this_month_paisa);
  return rest > 0n ? rest : 0n;
}

/**
 * The cashier records one purchase under a standing approval (ASSUMPTIONS 131): date, amount and the
 * shop's receipt, with no new vote. Open while `mandate` is set. With `onVoteInstead` it also offers
 * the ordinary vote, for something the approval does not cover.
 */
export function MandatePurchaseSheet({ partnerName, mandate, onClose, onSaved, onVoteInstead }: {
  partnerName: string;
  mandate: MandateRow | null;
  onClose: () => void;
  onSaved: () => void;
  onVoteInstead?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayDhaka());
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<'' | 'vori' | 'gram'>('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const close = () => {
    setDate(todayDhaka());
    setAmount('');
    setQuantity('');
    setUnit('');
    setNote('');
    setFile(null);
    onClose();
  };

  const left = mandate ? mandateLeft(mandate) : 0n;
  const amountPaisa = parseAmountInput(amount);
  // Only this month's room is known here; the server checks the limit of whichever month `date` is in.
  const tooMuch = mandate !== null && amountPaisa !== null && date.slice(0, 7) === todayDhaka().slice(0, 7) && BigInt(amountPaisa) > left;

  const save = async () => {
    if (!mandate) return;
    if (!amountPaisa || !file) throw new ApiError(400, 'request.invalid', 'amount and receipt');
    const form = new FormData();
    form.append('file', file);
    const up = await api<{ id: string }>('/files', { method: 'POST', body: form });
    await api(`/mandates/${mandate.id}/purchases`, {
      method: 'POST',
      body: {
        entry_date: date,
        amount_paisa: amountPaisa,
        receipt_file_id: up.id,
        ...(quantity.trim() ? { quantity: Number(quantity) } : {}),
        ...(unit ? { unit } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    void qc.invalidateQueries({ queryKey: ['mandate-purchases', mandate.id] });
    onSaved();
  };

  return (
    <ConfirmSheet
      open={mandate !== null}
      onClose={close}
      title={t('mandate.addPurchase')}
      confirmLabel={t('common.save')}
      canConfirm={amountPaisa !== null && !!file && !!date && !tooMuch}
      onConfirm={save}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('mandate.buyHint', { name: partnerName, left: taka(left) })}</p>
        <label className="field-label">
          {t('mandate.date')}
          <DateInput className="field mt-1 w-full" value={date} max={todayDhaka()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field-label">
          {t('common.amount')}
          <input className="field mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {tooMuch && <span className="field-hint text-bad">{t('errors.mandate.over_limit')}</span>}
        </label>
        <div className="field-label">
          {t('mandate.receipt')}
          <FilePicker className="mt-1 font-normal" file={file} onChange={setFile} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="field-label">
            {t('proposalFields.quantity')}<Optional />
            <input className="field mt-1 w-full" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>
          <label className="field-label">
            {t('proposalFields.unit')}<Optional />
            <select className="field mt-1 w-full" value={unit} onChange={(e) => setUnit(e.target.value as '' | 'vori' | 'gram')}>
              <option value="">—</option>
              <option value="vori">{t('proposalOptions.vori')}</option>
              <option value="gram">{t('proposalOptions.gram')}</option>
            </select>
          </label>
        </div>
        <label className="field-label">
          {t('holding.remark')}<Optional />
          <input className="field mt-1 w-full" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {onVoteInstead && (
          <button type="button" className="min-h-11 text-left text-sm font-semibold text-accent underline" onClick={() => { close(); onVoteInstead(); }}>
            {t('mandate.voteInstead')}
          </button>
        )}
      </div>
    </ConfirmSheet>
  );
}
