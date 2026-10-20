import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import * as repo from './repo';

export interface AdminDeps {
  pool: pg.Pool;
  clock: Clock;
}

function rowToDto(row: repo.NotificationRow) {
  return {
    id: row.id,
    member_id: row.member_id,
    template: row.template,
    channel: row.channel,
    payload: row.payload,
    status: row.status,
    scheduled_for: row.scheduled_for.toISOString(),
    sent_at: row.sent_at?.toISOString() ?? null,
    opened_at: row.opened_at?.toISOString() ?? null,
    error: row.error,
  };
}

export async function listAdminNotifications(
  deps: AdminDeps,
  filters: { period?: string; memberId?: string; template?: string; limit: number; cursor?: string },
) {
  const rows = await repo.listAdminNotifications(deps.pool, filters);
  const items = rows.slice(0, filters.limit).map(rowToDto);
  const nextCursor =
    rows.length > filters.limit
      ? `${rows[filters.limit]!.scheduled_for.toISOString()}:${rows[filters.limit]!.id}`
      : null;
  return { items, next_cursor: nextCursor };
}

/**
 * Members "not reachable by push" for the cashier dashboard.
 * A member is unreachable if they have no active push token, push is disabled,
 * or their most recent push in the lookback window was sent but never opened
 * and the template allows the cashier to phone them.
 */
export async function listUnreachableByPush(
  deps: AdminDeps,
  lookbackHours = 48,
): Promise<{ member_id: string; code: string; full_name: string; reason: string }[]> {
  const since = new Date(deps.clock.now().getTime() - lookbackHours * 3600_000);
  const res = await deps.pool.query(
    `WITH active_members AS (
       SELECT m.id, m.code, m.full_name
       FROM members m
       JOIN users u ON u.member_id = m.id
       WHERE m.status IN ('active', 'warning')
         AND u.status = 'active'
     ),
     push_state AS (
       SELECT u.member_id,
         bool_or(d.fcm_token IS NOT NULL AND d.revoked_at IS NULL AND d.push_enabled = true) AS has_token,
         bool_or(d.push_enabled = false AND d.revoked_at IS NULL) AS push_disabled
       FROM users u
       LEFT JOIN devices d ON d.user_id = u.id
       GROUP BY u.member_id
     ),
     unopened AS (
       SELECT n.member_id
       FROM notifications n
       WHERE n.channel = 'push'
         AND n.status = 'sent'
         AND n.sent_at > $1
         AND n.opened_at IS NULL
       GROUP BY n.member_id
       HAVING count(*) > 0
     )
     SELECT a.id AS member_id, a.code, a.full_name,
       CASE
         WHEN ps.push_disabled THEN 'push_disabled'
         WHEN NOT ps.has_token THEN 'no_push_token'
         WHEN u.member_id IS NOT NULL THEN 'recent_push_unopened'
         ELSE 'ok'
       END AS reason
     FROM active_members a
     LEFT JOIN push_state ps ON ps.member_id = a.id
     LEFT JOIN unopened u ON u.member_id = a.id
     WHERE ps.push_disabled = true OR NOT ps.has_token OR u.member_id IS NOT NULL`,
    [since],
  );
  return res.rows as { member_id: string; code: string; full_name: string; reason: string }[];
}
