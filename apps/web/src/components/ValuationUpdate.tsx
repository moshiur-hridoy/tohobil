import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { valuationVoteReason } from '@barakah/shared';
import { ConfirmSheet } from './ConfirmSheet';
import { DateInput, FilePicker } from './ui';
import { api, apiBlob } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, todayDhaka } from '../lib/dates';
import { parseAmountInput, taka } from '../lib/money';
import { uuid } from '../lib/uuid';
import type { MemberRow, PartnerRow, ValuationRequestRow } from '../lib/types';

/** Profit in green with a plus, loss in red with a minus. */
export function Change({ paisa, className = '' }: { paisa: bigint; className?: string }) {
  if (paisa === 0n) return <span className={`text-muted ${className}`}>{taka(0n)}</span>;
  return <span className={`${paisa > 0n ? 'text-ok' : 'text-bad'} ${className}`}>{paisa > 0n ? '+' : '−'}{taka(paisa > 0n ? paisa : -paisa)}</span>;
}

/**
 * Send a shop's new total value with its statement (ASSUMPTIONS 115). Before sending it says where the
 * update will go: a rise of up to 10% to the auditor, anything else to a three-day vote. The server
 * makes the same decision and the answer comes back to `onSent`.
 */
export function ValuationRequestSheet({ open, onClose, partner, currentValue, onSent }: {
  open: boolean;
  onClose: () => void;
  partner: PartnerRow;
  currentValue: bigint;
  onSent: (route: 'auditor' | 'vote') => void;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members'), enabled: open });
  const [total, setTotal] = useState('');
  const [asOf, setAsOf] = useState(todayDhaka());
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!open) return;
    setTotal('');
    setAsOf(todayDhaka());
    setNote('');
    setFile(null);
  }, [open]);

  const next = parseAmountInput(total);
  const auditors = (members.data?.items ?? []).filter((m) => m.roles?.includes('auditor')).map((m) => m.id);
  const reason = next === null ? null : valuationVoteReason({
    base: currentValue,
    next: BigInt(next),
    concernsAuditor: !!me?.roles.includes('auditor') || (!!partner.custodian_member_id && auditors.includes(partner.custodian_member_id)),
    hasAuditor: !members.data || auditors.length > 0,
  });
  const change = next === null ? 0n : BigInt(next) - currentValue;

  const send = async () => {
    if (next === null || !file) return;
    const form = new FormData();
    form.append('file', file);
    const up = await api<{ id: string }>('/files', { method: 'POST', body: form, headers: { 'Idempotency-Key': uuid() } });
    const out = await api<{ route: 'auditor' | 'vote' }>(`/partners/${partner.id}/valuation-requests`, {
      method: 'POST',
      body: { new_value_paisa: next, as_of: asOf, proof_file_id: up.id, ...(note.trim() ? { note: note.trim() } : {}) },
    });
    onSent(out.route);
  };

  return (
    <ConfirmSheet open={open} onClose={onClose} title={t('valuation.sendTitle', { name: partner.name })} confirmLabel={t('common.submit')} canConfirm={next !== null && file !== null && asOf <= todayDhaka()} onConfirm={send}>
      <p className="text-sm text-muted">{t('valuation.current', { value: taka(currentValue) })}</p>
      <label className="field-label">
        {t('valuation.newValue')}
        <input className="field mt-1 w-full" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
      </label>
      <label className="field-label">
        {t('valuation.asOf')}
        <DateInput className="field mt-1 w-full" value={asOf} max={todayDhaka()} onChange={(e) => setAsOf(e.target.value)} />
      </label>
      <label className="field-label">
        {t('valuation.note')}
        <input className="field mt-1 w-full" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('valuation.notePlaceholder')} />
      </label>
      <div>
        <p className="field-label">{t('valuation.statement')}</p>
        <FilePicker file={file} onChange={setFile} className="mt-1" />
      </div>
      {next !== null && (
        <div className={`rounded-xl p-3 text-sm ${reason === null ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}`}>
          <p className="font-semibold">{t(change < 0n ? 'valuation.loss' : 'valuation.gain')}: <Change paisa={change} /></p>
          <p className="mt-1">{t(reason === null ? 'valuation.toAuditor' : `valuation.toVote.${reason}`)}</p>
        </div>
      )}
    </ConfirmSheet>
  );
}

/** Where one sent update stands, in words. */
function statusKey(r: ValuationRequestRow): { key: string; tone: string } {
  if (r.route === 'auditor') {
    if (r.status === 'approved') return { key: 'valuation.status.approved', tone: 'bg-ok-bg text-ok' };
    if (r.status === 'rejected') return { key: 'valuation.status.rejected', tone: 'bg-bad-bg text-bad' };
    return { key: 'valuation.status.waitAuditor', tone: 'bg-warn-bg text-warn' };
  }
  if (r.status === 'executed') return { key: 'valuation.status.executed', tone: 'bg-ok-bg text-ok' };
  if (r.status === 'approved') return { key: 'valuation.status.passed', tone: 'bg-warn-bg text-warn' };
  if (r.status === 'rejected') return { key: 'valuation.status.failed', tone: 'bg-bad-bg text-bad' };
  if (r.status === 'lapsed' || r.status === 'cancelled') return { key: 'valuation.status.cancelled', tone: 'bg-soft text-muted' };
  return { key: 'valuation.status.voting', tone: 'bg-blue-bg text-blue' };
}

/** The value updates sent for a shop, newest first, with who sent them and what became of them. */
export function ValuationRequestList({ requests, voteLink }: { requests: ValuationRequestRow[]; voteLink: (proposalId: string) => string }) {
  const { t } = useTranslation();
  if (requests.length === 0) return <p className="text-sm text-muted">{t('valuation.noneSent')}</p>;
  const openStatement = async (fileId: string) => {
    window.open(URL.createObjectURL(await apiBlob(`/files/${fileId}`)), '_blank', 'noopener');
  };
  return (
    <ul className="divide-y divide-border text-sm">
      {requests.map((r) => {
        const s = statusKey(r);
        return (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="tabular-nums">
                {taka(r.base_value_paisa)} → <strong>{taka(r.new_value_paisa)}</strong>{' '}
                <Change paisa={BigInt(r.new_value_paisa) - BigInt(r.base_value_paisa)} className="text-xs" />
              </span>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.tone}`}>{t(s.key)}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {fmtDate(r.as_of)} · {t('valuation.sentBy', { code: r.requested_by_code ?? '?' })}
              {r.decided_by_code ? ` · ${t('valuation.decidedBy', { code: r.decided_by_code })}` : ''}
            </p>
            {r.note && <p className="mt-0.5 text-xs text-ink2">{r.note}</p>}
            {r.status === 'rejected' && r.decision_note && <p className="mt-0.5 text-xs text-bad">{t('valuation.reason', { reason: r.decision_note })}</p>}
            <div className="mt-1 flex gap-3 text-xs font-semibold">
              <button type="button" className="text-primary hover:underline" onClick={() => void openStatement(r.proof_file_id)}>{t('valuation.viewStatement')}</button>
              {r.proposal_id && <Link to={voteLink(r.proposal_id)} className="text-primary hover:underline">{t('valuation.viewVote')}</Link>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
