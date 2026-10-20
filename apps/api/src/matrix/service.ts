import type pg from 'pg';
import { addMonths, type Clock, type MatrixQuery } from '@barakah/shared';
import { badRequest } from '../lib/errors';
import { toBigInt } from '../lib/money';

export interface MatrixDeps {
  pool: pg.Pool;
  clock: Clock;
}

const MAX_PERIODS = 36;
const DEFAULT_PERIODS = 12;

type CellStatus = 'paid' | 'paid_late' | 'partial' | 'unpaid' | 'overdue';

interface Cell {
  status: CellStatus;
  due: bigint;
  paid: bigint;
  /** Fines charged on this period's dues (waived ones excluded). */
  fine: bigint;
  fine_paid: bigint;
  /** The member has a payment waiting for the cashier and this cell still owes something. */
  pending: boolean;
}

/** The worst status wins when a period has more than one due (monthly plus start boost). */
function combine(dues: Array<{ status: string; outstanding: bigint; allocated: bigint }>): CellStatus {
  if (dues.every((d) => d.outstanding <= 0n)) {
    return dues.some((d) => d.status === 'paid_late') ? 'paid_late' : 'paid';
  }
  if (dues.some((d) => d.outstanding > 0n && d.status === 'overdue')) return 'overdue';
  if (dues.some((d) => d.allocated > 0n)) return 'partial';
  return 'unpaid';
}

const str = (v: bigint): string => v.toString();

/**
 * `GET /matrix?from&to` (spec 7): the legacy sheet as data. One row per member in code order, one cell
 * per period (null when the member had no due then), with row and column totals. Every logged-in
 * member may read it: collection status is public inside the group (the home screen shows it too).
 * Defaults to the 12 periods that end this month.
 */
export async function getMatrix(deps: MatrixDeps, q: MatrixQuery) {
  const current = deps.clock.todayDhaka().slice(0, 7);
  const to = q.to ?? current;
  const from = q.from ?? addMonths(to, -(DEFAULT_PERIODS - 1));
  if (from > to) throw badRequest('matrix.invalid_range', '"from" must not be after "to"');

  const periods: string[] = [];
  for (let p = from; p <= to; p = addMonths(p, 1)) {
    periods.push(p);
    if (periods.length > MAX_PERIODS) {
      throw badRequest('matrix.range_too_long', `At most ${MAX_PERIODS} periods at a time`);
    }
  }

  const [members, dues, fines, pending] = await Promise.all([
    deps.pool.query(`SELECT id, code, full_name, status FROM members ORDER BY code`),
    deps.pool.query(
      `SELECT member_id, period, status, amount_paisa, allocated_paisa, outstanding_paisa
       FROM v_due_status WHERE period >= $1 AND period <= $2`,
      [from, to],
    ),
    deps.pool.query(
      `SELECT f.member_id, d.period, f.amount_paisa, s.allocated_paisa
       FROM fines f
       JOIN dues d ON d.id = f.due_id
       JOIN v_fine_status s ON s.fine_id = f.id
       WHERE f.waived_at IS NULL AND d.period >= $1 AND d.period <= $2`,
      [from, to],
    ),
    deps.pool.query(`SELECT DISTINCT member_id FROM payments WHERE status = 'pending'`),
  ]);

  const pendingMembers = new Set((pending.rows as Array<{ member_id: string }>).map((r) => r.member_id));

  type DueRow = { member_id: string; period: string; status: string; amount_paisa: unknown; allocated_paisa: unknown; outstanding_paisa: unknown };
  const duesByCell = new Map<string, DueRow[]>();
  for (const r of dues.rows as DueRow[]) {
    const key = `${r.member_id}|${r.period}`;
    duesByCell.set(key, [...(duesByCell.get(key) ?? []), r]);
  }
  const finesByCell = new Map<string, { fine: bigint; paid: bigint }>();
  for (const r of fines.rows as Array<{ member_id: string; period: string; amount_paisa: unknown; allocated_paisa: unknown }>) {
    const key = `${r.member_id}|${r.period}`;
    const cur = finesByCell.get(key) ?? { fine: 0n, paid: 0n };
    cur.fine += toBigInt(r.amount_paisa);
    cur.paid += toBigInt(r.allocated_paisa);
    finesByCell.set(key, cur);
  }

  const columnTotals = new Map<string, { due: bigint; paid: bigint; fine: bigint; fine_paid: bigint }>(
    periods.map((p) => [p, { due: 0n, paid: 0n, fine: 0n, fine_paid: 0n }]),
  );

  const rows = (members.rows as Array<{ id: string; code: string; full_name: string; status: string }>).map(
    (m) => {
      const cells: Record<string, ReturnType<typeof cellOut> | null> = {};
      const totals = { due: 0n, paid: 0n, outstanding: 0n, fine: 0n, fine_paid: 0n };
      for (const period of periods) {
        const key = `${m.id}|${period}`;
        const list = (duesByCell.get(key) ?? []).map((d) => ({
          status: d.status,
          outstanding: toBigInt(d.outstanding_paisa),
          allocated: toBigInt(d.allocated_paisa),
          amount: toBigInt(d.amount_paisa),
        }));
        if (list.length === 0) {
          cells[period] = null;
          continue;
        }
        const due = list.reduce((a, d) => a + d.amount, 0n);
        const outstanding = list.reduce((a, d) => a + (d.outstanding > 0n ? d.outstanding : 0n), 0n);
        const fine = finesByCell.get(key) ?? { fine: 0n, paid: 0n };
        const cell: Cell = {
          status: combine(list),
          due,
          paid: due - outstanding,
          fine: fine.fine,
          fine_paid: fine.paid,
          pending: outstanding > 0n && pendingMembers.has(m.id),
        };
        cells[period] = cellOut(cell);
        totals.due += cell.due;
        totals.paid += cell.paid;
        totals.outstanding += outstanding;
        totals.fine += cell.fine;
        totals.fine_paid += cell.fine_paid;
        const col = columnTotals.get(period) as { due: bigint; paid: bigint; fine: bigint; fine_paid: bigint };
        col.due += cell.due;
        col.paid += cell.paid;
        col.fine += cell.fine;
        col.fine_paid += cell.fine_paid;
      }
      return {
        member_id: m.id,
        member_code: m.code,
        member_name: m.full_name,
        member_status: m.status,
        cells,
        totals: {
          due_paisa: str(totals.due),
          paid_paisa: str(totals.paid),
          outstanding_paisa: str(totals.outstanding),
          fine_paisa: str(totals.fine),
          fine_paid_paisa: str(totals.fine_paid),
        },
      };
    },
  );

  return {
    from,
    to,
    periods,
    members: rows,
    totals_by_period: Object.fromEntries(
      [...columnTotals].map(([p, t]) => [
        p,
        {
          due_paisa: str(t.due),
          paid_paisa: str(t.paid),
          fine_paisa: str(t.fine),
          fine_paid_paisa: str(t.fine_paid),
        },
      ]),
    ),
  };
}

function cellOut(c: Cell) {
  return {
    status: c.status,
    due_paisa: str(c.due),
    paid_paisa: str(c.paid),
    fine_paisa: str(c.fine),
    fine_paid_paisa: str(c.fine_paid),
    pending: c.pending,
  };
}
