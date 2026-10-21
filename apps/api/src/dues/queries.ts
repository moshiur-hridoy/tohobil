import type { DuesQuery, FinesQuery } from '@barakah/shared';
import { decodeCursor, encodeCursor, tsKey } from '../lib/cursor';
import { paisaOut } from '../lib/money';
import type { Db } from '../lib/tx';

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Dues with their derived status (view `v_due_status`, spec 5.3).
 *
 * `under_verification` is true for a due that still has something to pay while its member has a
 * payment waiting for the cashier: the UI shows "under verification" instead of "unpaid" (spec 5.4).
 * A month that is not due yet only counts when the waiting payment names it.
 *
 * Note: `overdue` is judged against the database's Asia/Dhaka date, not the injectable Clock.
 */
export async function listDues(db: Db, q: DuesQuery): Promise<Page<Record<string, unknown>>> {
  const cursor = decodeCursor(q.cursor, 2); // [due_date, due_id]
  const res = await db.query(
    `SELECT v.due_id AS id, v.member_id, m.code AS member_code, m.full_name AS member_name,
            v.period, v.kind, v.shares_snapshot, v.amount_paisa, v.allocated_paisa,
            v.outstanding_paisa, v.due_date::text AS due_date, v.status,
            (v.outstanding_paisa > 0 AND EXISTS (
               SELECT 1 FROM payments p WHERE p.member_id = v.member_id AND p.status = 'pending'
                 AND (v.due_date <= (now() AT TIME ZONE 'Asia/Dhaka')::date OR v.period = ANY(COALESCE(p.for_periods, '{}')))
             )) AS under_verification
     FROM v_due_status v
     JOIN members m ON m.id = v.member_id
     WHERE ($1::text IS NULL OR v.period = $1)
       AND ($2::uuid IS NULL OR v.member_id = $2)
       AND ($3::text IS NULL OR v.status = $3)
       AND ($4::date IS NULL OR (v.due_date, v.due_id) < ($4::date, $5::uuid))
     ORDER BY v.due_date DESC, v.due_id DESC
     LIMIT $6`,
    [
      q.period ?? null,
      q.member_id ?? null,
      q.status ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      q.limit + 1,
    ],
  );
  const rows = res.rows as Array<Record<string, unknown> & { id: string; due_date: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      ...r,
      amount_paisa: paisaOut(r.amount_paisa),
      allocated_paisa: paisaOut(r.allocated_paisa),
      outstanding_paisa: paisaOut(r.outstanding_paisa),
    })),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.due_date, last.id]) : null,
  };
}

/** Fines with their derived status (view `v_fine_status`, spec 5.5). */
export async function listFines(db: Db, q: FinesQuery): Promise<Page<Record<string, unknown>>> {
  const cursor = decodeCursor(q.cursor, 2); // [created_at, id]
  const res = await db.query(
    `WITH base AS (
       SELECT f.id, f.due_id, f.member_id, m.code AS member_code, m.full_name AS member_name,
              f.kind, f.reason, d.period, f.amount_paisa, s.allocated_paisa, s.outstanding_paisa,
              f.waived_at, f.created_at, ${tsKey('f.created_at')} AS created_key,
              CASE WHEN f.waived_at IS NOT NULL THEN 'waived'
                   WHEN s.outstanding_paisa <= 0 THEN 'paid'
                   WHEN s.allocated_paisa > 0 THEN 'partial'
                   ELSE 'unpaid' END AS status
       FROM fines f
       JOIN v_fine_status s ON s.fine_id = f.id
       JOIN members m ON m.id = f.member_id
       LEFT JOIN dues d ON d.id = f.due_id
     )
     SELECT * FROM base
     WHERE ($1::uuid IS NULL OR member_id = $1)
       AND ($2::text IS NULL OR status = $2)
       AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $5`,
    [q.member_id ?? null, q.status ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, q.limit + 1],
  );
  const rows = res.rows as Array<Record<string, unknown> & { id: string; created_key: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ created_key: _key, ...r }) => ({
      ...r,
      amount_paisa: paisaOut(r.amount_paisa),
      allocated_paisa: paisaOut(r.allocated_paisa),
      outstanding_paisa: paisaOut(r.outstanding_paisa),
    })),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.created_key, last.id]) : null,
  };
}
