import { useTranslation } from 'react-i18next';

const TONE: Record<string, string> = {
  paid: 'text-ok',
  paid_late: 'text-ok',
  confirmed: 'text-ok',
  partial: 'text-warn',
  pending: 'text-warn',
  unpaid: 'text-muted',
  overdue: 'text-bad',
  rejected: 'text-bad',
  reversed: 'text-bad',
};

/** Colour plus a word and a glyph: status must never rely on colour alone. */
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { t } = useTranslation();
  const glyph = status.startsWith('paid') || status === 'confirmed' ? '✓' : status === 'overdue' || status === 'rejected' || status === 'reversed' ? '!' : '•';
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${TONE[status] ?? 'text-muted'}`}>
      <span aria-hidden="true">{glyph}</span>
      {label ?? t(`status.${status}`, { defaultValue: t(`payment.status.${status}`, { defaultValue: status }) })}
    </span>
  );
}
