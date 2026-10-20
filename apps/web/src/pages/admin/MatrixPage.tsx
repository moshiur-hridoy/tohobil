import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addMonths } from '@barakah/shared';
import { Skeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { StatusPill } from '../../components/StatusPill';
import { api } from '../../lib/api';
import { downloadCsv } from '../../lib/csv';
import { fmtPeriod, todayDhaka } from '../../lib/dates';
import { taka } from '../../lib/money';
import type { MatrixCell, MatrixResponse } from '../../lib/types';

const GLYPH: Record<string, string> = { paid: '✓', paid_late: '✓L', partial: '½', unpaid: '–', overdue: '!' };
const TONE: Record<string, string> = { paid: 'text-ok', paid_late: 'text-ok', partial: 'text-warn', unpaid: 'text-muted', overdue: 'text-bad' };

/** The legacy sheet as a grid: member x month, with row and column totals and a CSV export. */
export function MatrixPage() {
  const { t } = useTranslation();
  const current = todayDhaka().slice(0, 7);
  const [from, setFrom] = useState(addMonths(current, -11));
  const [to, setTo] = useState(current);
  const [cell, setCell] = useState<{ member: string; period: string; data: MatrixCell } | null>(null);

  const q = useQuery({
    queryKey: ['matrix', from, to],
    queryFn: () => api<MatrixResponse>(`/matrix?from=${from}&to=${to}`),
  });

  const exportCsv = () => {
    const m = q.data;
    if (!m) return;
    downloadCsv(`matrix-${m.from}-${m.to}.csv`, [
      ['member', 'name', ...m.periods.flatMap((p) => [`${p} status`, `${p} due`, `${p} paid`, `${p} fine`]), 'due total', 'paid total', 'outstanding', 'fine total'],
      ...m.members.map((r) => [
        r.member_code,
        r.member_name,
        ...m.periods.flatMap((p) => {
          const c = r.cells[p];
          return c ? [c.status, c.due_paisa, c.paid_paisa, c.fine_paisa] : ['', '', '', ''];
        }),
        r.totals.due_paisa,
        r.totals.paid_paisa,
        r.totals.outstanding_paisa,
        r.totals.fine_paisa,
      ]),
    ]);
  };

  const input = 'h-11 rounded-md border border-input bg-background px-2';
  const empty = q.data && q.data.members.every((m) => Object.values(m.cells).every((c) => c === null));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('matrixPage.title')}</h1>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-muted">
            {t('common.from')}
            <input type="month" className={`${input} block`} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
          <label className="text-sm text-muted">
            {t('common.to')}
            <input type="month" className={`${input} block`} value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </label>
          <button type="button" className="h-11 rounded-md border border-border px-4" onClick={exportCsv} disabled={!q.data}>
            {t('matrixPage.export')}
          </button>
        </div>
      </div>

      <p className="flex flex-wrap gap-x-4 text-sm" aria-label={t('matrixPage.legend')}>
        {Object.keys(GLYPH).map((s) => (
          <span key={s} className={TONE[s]}>{GLYPH[s]} {t(`status.${s}`)}</span>
        ))}
        <span className="text-warn">● {t('status.pending')}</span>
      </p>

      {q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-72 w-full" />
      ) : empty ? (
        <Empty text={t('matrixPage.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead className="text-muted">
              <tr>
                <th className="sticky left-0 z-10 bg-card p-2 text-left">{t('common.member')}</th>
                {q.data.periods.map((p) => (
                  <th key={p} className="p-2 text-center font-normal">{fmtPeriod(p)}</th>
                ))}
                <th className="p-2 text-right">{t('matrixPage.paid')}</th>
                <th className="p-2 text-right">{t('matrixPage.outstanding')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.members.map((m) => (
                <tr key={m.member_id} className="border-t border-border">
                  <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-card p-2 text-left font-medium">{m.member_code} {m.member_name}</th>
                  {q.data.periods.map((p) => {
                    const c = m.cells[p];
                    return (
                      <td key={p} className="p-0 text-center">
                        {c ? (
                          <button
                            type="button"
                            className={`h-11 w-full min-w-[3.25rem] px-2 font-medium hover:bg-hover ${TONE[c.status]}`}
                            aria-label={`${m.member_code} ${fmtPeriod(p)} ${t(`status.${c.status}`)}`}
                            onClick={() => setCell({ member: `${m.member_code} ${m.member_name}`, period: p, data: c })}
                          >
                            {GLYPH[c.status]}
                            {c.pending && <span className="text-warn" aria-hidden="true"> ●</span>}
                            {BigInt(c.fine_paisa) > 0n && <sup className="text-bad"> ₣</sup>}
                          </button>
                        ) : (
                          <span className="text-muted">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="p-2 text-right">{taka(m.totals.paid_paisa)}</td>
                  <td className="p-2 text-right font-medium">{taka(m.totals.outstanding_paisa)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-border font-medium">
              <tr>
                <th scope="row" className="sticky left-0 z-10 bg-card p-2 text-left">{t('matrixPage.collected')}</th>
                {q.data.periods.map((p) => (
                  <td key={p} className="p-2 text-center text-xs">{taka(q.data.totals_by_period[p]?.paid_paisa ?? '0')}</td>
                ))}
                <td className="p-2 text-right">{taka(q.data.members.reduce((a, m) => a + BigInt(m.totals.paid_paisa), 0n))}</td>
                <td className="p-2 text-right">{taka(q.data.members.reduce((a, m) => a + BigInt(m.totals.outstanding_paisa), 0n))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <Dialog.Root open={!!cell} onOpenChange={(o) => !o && setCell(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-4 shadow-lg">
            {cell && (
              <>
                <Dialog.Title className="mb-3 text-lg font-semibold">{t('matrixPage.cellTitle', { member: cell.member, period: fmtPeriod(cell.period) })}</Dialog.Title>
                <dl className="space-y-1">
                  <Row label={t('common.status')} value={<StatusPill status={cell.data.status} />} />
                  <Row label={t('matrixPage.due')} value={taka(cell.data.due_paisa)} />
                  <Row label={t('matrixPage.paid')} value={taka(cell.data.paid_paisa)} />
                  <Row label={t('matrixPage.outstanding')} value={taka(BigInt(cell.data.due_paisa) - BigInt(cell.data.paid_paisa))} />
                  <Row label={t('matrixPage.fine')} value={taka(cell.data.fine_paisa)} />
                  <Row label={t('matrixPage.finePaid')} value={taka(cell.data.fine_paid_paisa)} />
                </dl>
                {cell.data.pending && <p className="mt-2 text-warn">{t('matrixPage.pendingFlag')}</p>}
                <Dialog.Close className="mt-4 h-11 w-full rounded-md border border-border">{t('common.close')}</Dialog.Close>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
