import type { AuditLogQuery } from '@barakah/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { badRequest } from '../lib/errors';
import type { Db } from '../lib/tx';

export interface AuditPage {
  items: Array<Record<string, unknown>>;
  next_cursor: string | null;
}

/**
 * The audit log for the cashier and the auditor (spec 7, 19.4), newest first with keyset paging on
 * the row id. `from` and `to` are Asia/Dhaka calendar days, both inclusive. `actor_code` is the
 * member code of the acting user, `null` for the system (jobs, the CLI).
 */
export async function listAuditLog(db: Db, q: AuditLogQuery): Promise<AuditPage> {
  const cursor = decodeCursor(q.cursor, 1);
  if (cursor && !/^\d{1,18}$/.test(cursor[0] as string)) {
    throw badRequest('request.invalid_cursor', 'The cursor is not valid');
  }
  const res = await db.query(
    `SELECT a.id::text AS id, a.actor_user_id, m.code AS actor_code, a.action, a.entity_type,
            a.entity_id, a.before, a.after, host(a.ip) AS ip, a.device_id, a.created_at
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id
     LEFT JOIN members m ON m.id = u.member_id
     WHERE ($1::uuid IS NULL OR a.actor_user_id = $1::uuid)
       AND ($2::text IS NULL OR a.action = $2)
       AND ($3::text IS NULL OR a.entity_type = $3)
       AND ($4::text IS NULL OR a.entity_id = $4)
       AND ($5::date IS NULL OR a.created_at >= ($5::date::timestamp AT TIME ZONE 'Asia/Dhaka'))
       AND ($6::date IS NULL OR a.created_at < (($6::date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka'))
       AND ($7::bigint IS NULL OR a.id < $7::bigint)
     ORDER BY a.id DESC
     LIMIT $8`,
    [
      q.actor_user_id ?? null,
      q.action ?? null,
      q.entity_type ?? null,
      q.entity_id ?? null,
      q.from ?? null,
      q.to ?? null,
      cursor?.[0] ?? null,
      q.limit + 1,
    ],
  );
  const rows = res.rows as Array<Record<string, unknown> & { id: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.id]) : null,
  };
}
