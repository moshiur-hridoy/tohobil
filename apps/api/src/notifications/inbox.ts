import type pg from 'pg';
import type { Logger } from 'pino';
import { formatBDT, type Clock } from '@barakah/shared';
import { renderNotification } from './catalog';
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

/**
 * Payment notices queued before 1.11 carry no `_body` (the payments code stored only ids), so the
 * notices page showed an empty card. Their text is rendered here from the payment, read-only; the
 * stored row is left as it is.
 */
async function withPaymentBodies<T extends { template: string; payload: Record<string, unknown> }>(pool: pg.Pool, items: T[]): Promise<T[]> {
  const missing = items.filter(
    (n) => (n.template === 'payment_confirmed' || n.template === 'payment_rejected') && !n.payload._body && typeof n.payload.payment_id === 'string',
  );
  if (!missing.length) return items;
  const res = await pool.query(
    `SELECT id::text, amount_paisa::text AS amount_paisa, reject_reason FROM payments WHERE id = ANY($1::uuid[])`,
    [missing.map((n) => n.payload.payment_id as string)],
  );
  const byId = new Map((res.rows as Array<{ id: string; amount_paisa: string; reject_reason: string | null }>).map((r) => [r.id, r]));
  return items.map((n) => {
    if (!missing.includes(n)) return n;
    const pay = byId.get(n.payload.payment_id as string);
    if (!pay) return n;
    const amount = formatBDT(BigInt(pay.amount_paisa), { digits: 'bn' });
    const { body } = renderNotification(n.template as 'payment_confirmed' | 'payment_rejected', { amount, reason: pay.reject_reason ?? (n.payload.reason as string | undefined) });
    return { ...n, payload: { ...n.payload, _body: body } };
  });
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
  const items = await withPaymentBodies(deps.pool, rows.slice(0, filters.limit).map(rowToDto));
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

/**
 * "Mark all as read" on the notices page: every unopened in-app (push) notice of this member gets the
 * same opened time. SMS rows are left alone; they are not in the in-app list. Returns how many changed.
 */
export async function openAllNotifications(deps: InboxDeps, memberId: string): Promise<number> {
  const res = await deps.pool.query(
    `UPDATE notifications SET opened_at = $2
     WHERE member_id = $1 AND channel = 'push' AND opened_at IS NULL`,
    [memberId, deps.clock.now()],
  );
  return res.rowCount ?? 0;
}
