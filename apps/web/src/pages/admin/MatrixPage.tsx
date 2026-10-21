import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addMonths } from '@barakah/shared';
import { Skeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { Icon } from '../../components/ui';
import { AdminHeader, AdminPage, BTN_SECONDARY, Card, ICONS, InfoRow, Segmented, StatGrid, StatTile } from '../../components/admin';
import { api } from '../../lib/api';
import { downloadCsv } from '../../lib/csv';
import { fmtDate, fmtPeriod, todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';
import type { DueStatus, MatrixCell, MatrixResponse } from '../../lib/types';

/**
 * Each status is a glyph plus a tint, so it never relies on colour alone. Paid cells stay quiet so
 * the exceptions (yellow: paid with a fine, red: overdue) stand out when scanning the grid.
 */
type Look = DueStatus | 'advance';

const CELL: Record<Look, { glyph: string; tone: string; chip: string; legend: string }> = {
  // Paid before the month began: a small reward, so paying ahead is visible to everyone.
  advance: { glyph: '★', tone: 'bg-primary-soft text-primary', chip: 'bg-primary-soft text-primary', legend: 'matrixPage.legendAdvance' },
  paid: { glyph: '✓', tone: 'text-ok opacity-80 hover:bg-ok-bg hover:opacity-100', chip: 'bg-ok-bg text-ok', legend: 'matrixPage.legendPaid' },
  paid_late: { glyph: '✓', tone: 'bg-warn-bg text-warn', chip: 'bg-warn-bg text-warn', legend: 'matrixPage.legendLate' },
  partial: { glyph: '½', tone: 'bg-warn-bg text-warn', chip: 'bg-warn-bg text-warn', legend: 'matrixPage.legendPartial' },
  unpaid: { glyph: '–', tone: 'bg-soft text-muted', chip: 'bg-soft text-muted', legend: 'matrixPage.legendUnpaid' },
  overdue: { glyph: '!', tone: 'bg-bad-bg text-bad', chip: 'bg-bad-bg text-bad', legend: 'matrixPage.legendOverdue' },
};

/**
 * The member column is pinned on the left and the two total columns on the right, so only the months
 * scroll sideways on a narrow screen. Fixed widths let the paid column sit exactly left of the balance.
 */
const OWED_COL = 'sticky right-0 w-36 min-w-36 border-border px-4 text-right';
const PAID_COL = 'sticky right-36 w-32 min-w-32 border-l border-border px-4 text-right';

const look = (c: MatrixCell): Look => (c.advance ? 'advance' : c.status);

const sum = (values: string[]): bigint => values.reduce((a, v) => a + BigInt(v), 0n);
const percent = (part: bigint, whole: bigint): number => (whole > 0n ? Number((part * 100n) / whole) : 0);

/**
 * What a member owes up to this month, and what they have paid for months still to come. Future months
 * are not "owed" yet, so they stay out of the balance; money paid towards them shows as an advance.
 */
function balanceOf(cells: Record<string, MatrixCell | null>, current: string) {
  let due = 0n, fine = 0n, advance = 0n;
  for (const [p, c] of Object.entries(cells)) {
    if (!c) continue;
    if (p > current) { advance += BigInt(c.paid_paisa); continue; }
    const o = owedOf(c);
    due += o.due;
    fine += o.fine;
  }
  return { due, fine, advance };
}

/** What a cell still owes: the unpaid part of its dues plus its unpaid fine. */
function owedOf(c: MatrixCell) {
  const due = BigInt(c.due_paisa) - BigInt(c.paid_paisa);
  const fine = BigInt(c.fine_paisa) - BigInt(c.fine_paid_paisa);
  return { due: due > 0n ? due : 0n, fine: fine > 0n ? fine : 0n, total: (due > 0n ? due : 0n) + (fine > 0n ? fine : 0n) };
}

function StatusChip({ status }: { status: Look }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${CELL[status].chip}`}>
      <span aria-hidden="true">{CELL[status].glyph}</span>
      {t(CELL[status].legend)}
    </span>
  );
}

/** The numbers behind one cell; shared by the hover card and the tap dialog. */
function CellDetails({ data }: { data: MatrixCell }) {
  const { t } = useTranslation();
  const owed = owedOf(data);
  const fine = BigInt(data.fine_paisa);
  return (
    <dl>
      <InfoRow label={t('common.status')} value={<StatusChip status={look(data)} />} />
      <InfoRow label={t('matrixPage.due')} value={taka(data.due_paisa)} />
      <InfoRow label={t('matrixPage.paid')} value={taka(data.paid_paisa)} />
      {data.paid_on && <InfoRow label={t('matrixPage.paidOn')} value={fmtDate(data.paid_on)} />}
      {owed.due > 0n && <InfoRow label={t('matrixPage.outstanding')} value={taka(owed.due)} valueClass="text-bad" />}
      {fine > 0n && <InfoRow label={t('matrixPage.fine')} value={taka(fine)} />}
      {fine > 0n && (
        owed.fine > 0n
          ? <InfoRow label={t('matrixPage.fineUnpaid')} value={taka(owed.fine)} valueClass="text-bad" />
          : <InfoRow label={t('matrixPage.finePaid')} value={taka(data.fine_paid_paisa)} valueClass="text-ok" />
      )}
      {owed.total > 0n && <InfoRow label={t('matrixPage.totalOwed')} value={taka(owed.total)} valueClass="text-bad font-bold" />}
    </dl>
  );
}

type Hover = { member: string; period: string; data: MatrixCell; x: number; top: number; bottom: number };

/** The legacy sheet as a grid: member x month, with row and column totals and a CSV export. */
export function MatrixPage() {
  const { t } = useTranslation();
  const current = todayDhaka().slice(0, 7);
  // The fund year runs December to December, and members often pay ahead, so the default view
  // is last December through this December; it opens scrolled to the current month.
  const yearEnd = `${current.slice(0, 4)}-12`;
  const [from, setFrom] = useState(addMonths(yearEnd, -12));
  const [to, setTo] = useState(yearEnd);
  const scroller = useRef<HTMLDivElement>(null);
  const currentHead = useRef<HTMLTableCellElement>(null);
  const [cell, setCell] = useState<{ member: string; period: string; data: MatrixCell } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const presets: Array<[string, string, string]> = [
    ['matrixPage.last6', addMonths(current, -5), current],
    ['matrixPage.last12', addMonths(current, -11), current],
    ['matrixPage.thisYear', addMonths(yearEnd, -12), yearEnd],
  ];

  const q = useQuery({
    queryKey: ['matrix', from, to],
    queryFn: () => api<MatrixResponse>(`/matrix?from=${from}&to=${to}`),
  });

  // Months before the first due (before the fund started) are left out.
  const firstUsed = q.data?.periods.findIndex((p) => q.data?.members.some((m) => m.cells[p])) ?? -1;
  const periods = q.data && firstUsed >= 0 ? q.data.periods.slice(firstUsed) : (q.data?.periods ?? []);

  useEffect(() => {
    const box = scroller.current;
    const head = currentHead.current;
    if (!box || !head) return;
    // Keep the current month as the last fully visible column; later months are a scroll away.
    box.scrollLeft = Math.max(0, head.offsetLeft + head.offsetWidth - box.clientWidth);
  }, [q.data]);

  const exportCsv = () => {
    const m = q.data;
    if (!m) return;
    downloadCsv(`matrix-${m.from}-${m.to}.csv`, [
      ['member', 'name', ...periods.flatMap((p) => [`${p} status`, `${p} due`, `${p} paid`, `${p} fine`]), 'due total', 'paid total', 'outstanding', 'fine total'],
      ...m.members.map((r) => [
        r.member_code,
        r.member_name,
        ...periods.flatMap((p) => {
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

  const showHover = (el: HTMLElement, member: string, period: string, data: MatrixCell) => {
    const r = el.getBoundingClientRect();
    setHover({ member, period, data, x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  };

  const cells = q.data?.members.flatMap((m) => Object.values(m.cells).filter((c): c is MatrixCell => c !== null)) ?? [];
  const empty = q.data && cells.length === 0;
  const overdueCells = cells.filter((c) => c.status === 'overdue');
  const hoverCol = hover?.period;

  return (
    <AdminPage>
      <AdminHeader
        title={t('matrixPage.title')}
        subtitle={t('matrixPage.subtitle')}
        actions={
          <>
            <Segmented
              label={t('matrixPage.range')}
              value={presets.find(([, f, tt]) => from === f && to === tt)?.[0] ?? ''}
              options={presets.map(([key]) => ({ value: key, label: t(key) }))}
              onChange={(key) => {
                const p = presets.find(([k]) => k === key);
                if (p) { setFrom(p[1]); setTo(p[2]); }
              }}
            />
            <div className="flex items-center gap-2">
              <input type="month" aria-label={t('common.from')} className="field w-[10.5rem]" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
              <span className="text-muted">–</span>
              <input type="month" aria-label={t('common.to')} className="field w-[10.5rem]" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </div>
            <button type="button" className={BTN_SECONDARY} onClick={exportCsv} disabled={!q.data}>
              <Icon d={ICONS.download} size={18} />
              {t('matrixPage.export')}
            </button>
          </>
        }
      />

      <StatGrid>
        <StatTile tone="bg-ok-bg text-ok" icon={ICONS.check} label={t('matrixPage.statOnTime')}
          value={q.data ? formatCount(cells.filter((c) => c.status === 'paid').length) : null}
          sub={t('matrixPage.statOfCells', { n: formatCount(cells.length) })} />
        <StatTile tone="bg-warn-bg text-warn" icon={ICONS.clock} label={t('matrixPage.statLate')}
          value={q.data ? formatCount(cells.filter((c) => c.status === 'paid_late').length) : null}
          sub={t('matrixPage.statFined', { n: formatCount(cells.filter((c) => BigInt(c.fine_paisa) > 0n).length) })} />
        <StatTile tone="bg-bad-bg text-bad" icon={ICONS.alert} label={t('matrixPage.statOverdue')}
          value={q.data ? formatCount(overdueCells.length) : null} valueClass={overdueCells.length > 0 ? 'text-bad' : ''}
          sub={t('matrixPage.statOverdueSum', { amount: taka(overdueCells.reduce((a, c) => a + owedOf(c).total, 0n)) })} />
        <StatTile tone="bg-blue-bg text-blue" icon={ICONS.hourglass} label={t('matrixPage.statPending')}
          value={q.data ? formatCount(cells.filter((c) => c.pending).length) : null}
          sub={t('matrixPage.statPendingSub')} />
      </StatGrid>

      {q.error ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton className="h-96 w-full rounded-[20px]" />
      ) : empty ? (
        <Empty text={t('matrixPage.empty')} />
      ) : (
        <Card className="overflow-hidden">
          <div ref={scroller} className="overflow-x-auto overscroll-x-contain" onScroll={() => setHover(null)}>
          <table className="w-full min-w-max border-separate border-spacing-0 text-sm" onMouseLeave={() => setHover(null)}>
            <thead>
              <tr className="text-xs font-semibold text-muted">
                <th className="sticky left-0 z-20 border-b border-r border-border bg-card px-4 py-3 text-left">{t('common.member')}</th>
                {periods.map((p) => (
                  <th key={p} ref={p === current ? currentHead : undefined} className={`border-b border-border px-1 py-3 text-center font-semibold transition-colors ${p === current ? 'bg-primary-soft text-primary' : ''} ${p === hoverCol ? 'text-ink2' : ''}`}>
                    {fmtPeriod(p)}
                  </th>
                ))}
                <th className={`${PAID_COL} z-20 border-b bg-card py-3`}>{t('matrixPage.paid')}</th>
                <th className={`${OWED_COL} z-20 border-b bg-card py-3`}>{t('matrixPage.outstanding')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.members.map((m) => {
                const { due: owes, fine: fineOwed, advance: advancePaid } = balanceOf(m.cells, current);
                const label = `${m.member_code} ${m.member_name}`;
                // Months after this one already paid: shown as a badge next to the name.
                const ahead = periods.filter((p) => p > current && m.cells[p]?.advance).length;
                return (
                  <tr key={m.member_id} className="group">
                    <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-border bg-card px-4 py-2 text-left font-normal transition-colors group-hover:bg-hover">
                      <span className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-soft text-[0.6875rem] font-bold text-ink2">{m.member_code}</span>
                        <span className="font-semibold">{m.member_name}</span>
                        {ahead > 0 && (
                          <span title={t('matrixPage.aheadTitle')} className="whitespace-nowrap rounded-full bg-primary-soft px-2 py-0.5 text-[0.6875rem] font-bold text-primary">
                            ★ {t('matrixPage.ahead', { n: formatCount(ahead) })}
                          </span>
                        )}
                      </span>
                    </th>
                    {periods.map((p) => {
                      const c = m.cells[p];
                      const owed = c ? owedOf(c) : null;
                      // Unpaid cells print what they still owe (dues plus fine), so the amount reads without a click.
                      const showAmount = c && owed && owed.total > 0n && (c.status === 'overdue' || c.status === 'partial');
                      return (
                        <td key={p} className={`border-b border-border px-1 py-1.5 text-center transition-colors group-hover:bg-hover ${p === current ? 'bg-primary-soft' : ''} ${p === hoverCol ? 'bg-hover' : ''}`}>
                          {c ? (
                            <button
                              type="button"
                              aria-label={`${label} ${fmtPeriod(p)}: ${t(CELL[look(c)].legend)}${owed && owed.total > 0n ? `, ${t('matrixPage.totalOwed')} ${taka(owed.total)}` : ''}${c.pending ? `, ${t('matrixPage.legendPending')}` : ''}`}
                              onClick={() => { setHover(null); setCell({ member: label, period: p, data: c }); }}
                              onMouseEnter={(e) => showHover(e.currentTarget, label, p, c)}
                              onFocus={(e) => showHover(e.currentTarget, label, p, c)}
                              onBlur={() => setHover(null)}
                              className={`mx-auto grid h-9 w-full min-w-[3rem] max-w-[5.5rem] place-items-center rounded-lg font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${showAmount ? 'px-1.5 text-xs tabular-nums' : 'text-base'} ${CELL[look(c)].tone} ${c.pending ? 'ring-2 ring-inset ring-warn' : ''} hover:brightness-125`}
                            >
                              {showAmount ? <span className="whitespace-nowrap">{c.status === 'partial' ? '½ ' : ''}{taka(owed.total)}</span> : CELL[look(c)].glyph}
                            </button>
                          ) : (
                            <span className="text-border" aria-label={t('matrixPage.legendNone')}>·</span>
                          )}
                        </td>
                      );
                    })}
                    <td className={`${PAID_COL} z-10 whitespace-nowrap border-b bg-card py-2 tabular-nums transition-colors group-hover:bg-hover`}>{taka(m.totals.paid_paisa)}</td>
                    <td className={`${OWED_COL} z-10 whitespace-nowrap border-b bg-card py-2 tabular-nums transition-colors group-hover:bg-hover`}>
                      {(owes > 0n || advancePaid === 0n) && <div className={`font-semibold ${owes > 0n ? 'text-bad' : 'text-muted'}`}>{taka(owes)}</div>}
                      {advancePaid > 0n && <div className={owes > 0n ? 'text-[0.6875rem] font-semibold text-ok' : 'font-semibold text-ok'}>+{taka(advancePaid)}</div>}
                      {fineOwed > 0n && <div className="text-[0.6875rem] text-bad">{t('matrixPage.plusFine', { amount: taka(fineOwed) })}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-soft">
                <th scope="row" className="sticky left-0 z-10 border-r border-border bg-soft px-4 py-3 text-left text-sm font-bold">{t('matrixPage.collected')}</th>
                {periods.map((p) => {
                  const tot = q.data.totals_by_period[p];
                  const paid = BigInt(tot?.paid_paisa ?? '0');
                  const due = BigInt(tot?.due_paisa ?? '0');
                  return (
                    <td key={p} className="px-1 py-2 text-center">
                      <div className="text-xs font-semibold tabular-nums">{taka(paid)}</div>
                      {due > 0n && <div className={`text-[0.6875rem] tabular-nums ${percent(paid, due) >= 100 ? 'text-ok' : 'text-bad'}`}>{formatCount(percent(paid, due))}%</div>}
                    </td>
                  );
                })}
                <td className={`${PAID_COL} z-10 whitespace-nowrap bg-soft py-3 font-bold tabular-nums`}>{taka(sum(q.data.members.map((m) => m.totals.paid_paisa)))}</td>
                <td className={`${OWED_COL} z-10 whitespace-nowrap bg-soft py-3 font-bold text-bad tabular-nums`}>{taka(q.data.members.reduce((a, m) => a + balanceOf(m.cells, current).due, 0n))}</td>
              </tr>
            </tfoot>
          </table>
          </div>
        </Card>
      )}

      {/* Hover card: the cell's numbers without a click. Placed above the cell, or below near the top. */}
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-40 w-64 -translate-x-1/2 rounded-2xl border border-border bg-card px-4 py-3 text-sm shadow-lift [&_dl>div]:min-h-0 [&_dl>div]:py-1.5"
          style={hover.top > 300 ? { left: hover.x, top: hover.top - 8, transform: 'translate(-50%, -100%)' } : { left: hover.x, top: hover.bottom + 8 }}
        >
          <div className="mb-1 font-semibold">{t('matrixPage.cellTitle', { member: hover.member, period: fmtPeriod(hover.period) })}</div>
          <CellDetails data={hover.data} />
          {hover.data.pending && <p className="mt-2 text-xs text-warn">{t('matrixPage.pendingFlag')}</p>}
        </div>
      )}

      {/* Legend: the same chips as the grid, in plain words */}
      <ul aria-label={t('matrixPage.legend')} className="flex flex-wrap gap-x-5 gap-y-2.5 text-[0.8125rem] text-ink2">
        {(Object.keys(CELL) as Look[]).map((s) => (
          <li key={s} className="flex items-center gap-2">
            <span aria-hidden="true" className={`grid h-6 w-7 place-items-center rounded-md text-sm font-bold ${CELL[s].chip}`}>{CELL[s].glyph}</span>
            {t(CELL[s].legend)}
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="h-6 w-7 rounded-md bg-soft ring-2 ring-inset ring-warn" />
          {t('matrixPage.legendPending')}
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="grid h-6 place-items-center rounded-md bg-bad-bg px-1.5 text-[0.6875rem] font-bold text-bad">৳</span>
          {t('matrixPage.legendAmount')}
        </li>
      </ul>

      <Dialog.Root open={!!cell} onOpenChange={(o) => !o && setCell(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[24px] border border-border bg-card p-6 shadow-lift">
            {cell && (
              <>
                <Dialog.Title className="mb-4 text-lg font-bold">{t('matrixPage.cellTitle', { member: cell.member, period: fmtPeriod(cell.period) })}</Dialog.Title>
                <CellDetails data={cell.data} />
                {cell.data.pending && <p className="mt-3 rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn">{t('matrixPage.pendingFlag')}</p>}
                <Dialog.Close className="mt-5 h-11 w-full rounded-xl border border-border font-medium transition-colors hover:bg-hover">{t('common.close')}</Dialog.Close>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </AdminPage>
  );
}
