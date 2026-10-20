import type pg from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '@barakah/shared';
import * as repo from './repo';

export interface InboxDeps {
  pool: pg.Pool;
  clock: Clock;
  log?: Logger;
}

function rowToDto(row: repo.NotificationRow) {
  return {
    id: row.id,
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

export async function listInbox(
  deps: InboxDeps,
  memberId: string,
  filters: {
    status?: 'queued' | 'sent' | 'failed' | 'skipped';
    channel?: 'push' | 'sms';
    unreadOnly?: boolean;
    limit: number;
    cursor?: string;
  },
) {
  const rows = await repo.listMemberNotifications(deps.pool, memberId, filters);
  const items = rows.slice(0, filters.limit).map(rowToDto);
  const nextCursor =
    rows.length > filters.limit
      ? `${rows[filters.limit]!.scheduled_for.toISOString()}:${rows[filters.limit]!.id}`
      : null;
  return { items, next_cursor: nextCursor };
}

export async function openNotification(
  deps: InboxDeps,
  memberId: string,
  notificationId: string,
): Promise<boolean> {
  const res = await deps.pool.query(
    `UPDATE notifications SET opened_at = $3
     WHERE id = $1 AND member_id = $2 AND opened_at IS NULL
     RETURNING id`,
    [notificationId, memberId, deps.clock.now()],
  );
  return (res.rowCount ?? 0) > 0;
}
