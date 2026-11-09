import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtInstant } from '../lib/dates';
import { localDigits } from '../lib/format';
import { ConfirmSheet } from './ConfirmSheet';

interface EntryRemark {
  id: string;
  text: string;
  created_at: string;
  by_code: string | null;
}

/** The cashier and the auditor write remarks; everyone else only reads the ones they may see. */
export function useCanRemark(): boolean {
  const { me } = useAuth();
  return !!me && !me.read_only && (me.roles.includes('cashier') || me.roles.includes('auditor'));
}

/**
 * The newest remark on a ledger entry, with a button for the cashier and the auditor to add or change
 * it (ASSUMPTIONS 128). Changing it adds a newer remark; the entry itself never changes.
 */
export function RemarkLine({ seq, remark, count, onSaved }: { seq: string; remark: string | null | undefined; count: number | undefined; onSaved?: () => void }) {
  const { t } = useTranslation();
  const canWrite = useCanRemark();
  const [open, setOpen] = useState(false);
  if (!remark && !canWrite) return null;
  return (
    <span className="mt-1 block">
      {remark && (
        <span className="block whitespace-pre-line text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold text-ink2">{t('remarks.title')}:</span> {remark}
        </span>
      )}
      {canWrite && (
        <button type="button" onClick={() => setOpen(true)} className="mt-0.5 text-xs font-semibold text-primary hover:underline">
          {remark ? t('remarks.change') : t('remarks.add')}
          {(count ?? 0) > 1 && <span className="font-normal text-muted"> · {t('remarks.historyCount', { n: localDigits(String((count ?? 1) - 1)) })}</span>}
        </button>
      )}
      {canWrite && <RemarkSheet seq={seq} open={open} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </span>
  );
}

function RemarkSheet({ seq, open, onClose, onSaved }: { seq: string; open: boolean; onClose: () => void; onSaved?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const history = useQuery({
    queryKey: ['entry-remarks', seq],
    queryFn: () => api<{ items: EntryRemark[] }>(`/ledger/${seq}/remarks`),
    enabled: open,
  });
  const current = history.data?.items[0];

  // Start from the remark in force, so a small fix is a small edit.
  useEffect(() => {
    if (open) setText(current?.text ?? '');
  }, [open, current?.id]);

  const trimmed = text.trim();
  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={t('remarks.sheetTitle', { seq: localDigits(seq) })}
      confirmLabel={t('common.save')}
      canConfirm={trimmed.length > 0 && trimmed !== current?.text}
      onConfirm={async () => {
        await api(`/ledger/${seq}/remarks`, { method: 'POST', body: { text: trimmed } });
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['entry-remarks', seq] }),
          qc.invalidateQueries({ queryKey: ['ledger'] }),
        ]);
        onSaved?.();
      }}
    >
      <p className="text-muted">{t('remarks.body')}</p>
      <textarea
        aria-label={t('remarks.title')}
        placeholder={t('remarks.placeholder')}
        className="field min-h-24 w-full"
        maxLength={500}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {history.data && history.data.items.length > 0 && (
        <div>
          <p className="text-sm font-semibold">{t('remarks.history')}</p>
          <ul className="mt-1 space-y-1.5 text-sm">
            {history.data.items.map((r, i) => (
              <li key={r.id} className={i === 0 ? '' : 'text-muted'}>
                <span className="block whitespace-pre-line [overflow-wrap:anywhere]">{r.text}</span>
                <span className="block text-xs text-muted">
                  {[r.by_code, fmtInstant(r.created_at), i === 0 ? t('remarks.current') : null].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ConfirmSheet>
  );
}
