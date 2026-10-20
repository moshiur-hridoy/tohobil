import { useTranslation } from 'react-i18next';

const TONE: Record<string, string> = {
  paid: 'bg-ok-bg text-ok',
  paid_late: 'bg-ok-bg text-ok',
  confirmed: 'bg-ok-bg text-ok',
  partial: 'bg-warn-bg text-warn',
  pending: 'bg-warn-bg text-warn',
  unpaid: 'bg-soft text-muted',
  overdue: 'bg-bad-bg text-bad',
  rejected: 'bg-bad-bg text-bad',
  reversed: 'bg-bad-bg text-bad',
};

/** Colour plus a word and a glyph: status must never rely on colour alone. */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { t } = useTranslation();
  const glyph = status.startsWith('paid') || status === 'confirmed' ? '✓' : status === 'overdue' || status === 'rejected' || status === 'reversed' ? '!' : '•';
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[status] ?? 'bg-soft text-muted'}`}>
      <span aria-hidden="true">{glyph}</span>
      {label ?? t(`status.${status}`, { defaultValue: t(`payment.status.${status}`, { defaultValue: status }) })}
    </span>
  );
}
