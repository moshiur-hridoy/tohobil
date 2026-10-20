import type { NotificationChannel, NotificationStatus } from '@barakah/shared';
import type { Db } from '../lib/tx';
import type { NotificationTemplate } from './catalog';

const SELECT_COLUMNS = `id, member_id, template, channel, payload, dedupe_key,
  scheduled_for, sent_at, delivered_at, opened_at, status, error`;

export interface NotificationRow {
  id: string;
  member_id: string;
  template: NotificationTemplate;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  scheduled_for: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  opened_at: Date | null;
  status: NotificationStatus;
  error: string | null;
}

export async function insertNotification(
  db: Db,
  row: {
    memberId: string;
    template: NotificationTemplate;
    channel: NotificationChannel;
    payload: Record<string, unknown>;
    dedupeKey: string;
    scheduledFor: Date;
  },
): Promise<string | null> {
  try {
    const res = await db.query(
      `INSERT INTO notifications (member_id, template, channel, payload, dedupe_key, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [row.memberId, row.template, row.channel, JSON.stringify(row.payload), row.dedupeKey, row.scheduledFor],
    );
    return ((res.rows[0] as { id: string } | undefined)?.id) ?? null;
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'notifications_dedupe_key_key') return null;
    throw err;
  }
}

export async function queueForMember(
  db: Db,
  memberId: string,
  template: NotificationTemplate,
  channels: NotificationChannel[],
  payload: Record<string, unknown>,
  dedupeKey: string,
  scheduledFor: Date,
): Promise<string[]> {
  const ids: string[] = [];
  for (const channel of channels) {
    const id = await insertNotification(db, {
      memberId,
      template,
      channel,
      payload,
      dedupeKey: `${dedupeKey}:${channel}`,
      scheduledFor,
    });
    if (id) ids.push(id);
  }
  return ids;
}

export async function fetchDueNotifications(
  db: Db,
  now: Date,
  batchSize = 100,
): Promise<NotificationRow[]> {
  const res = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM notifications
     WHERE status = 'queued' AND scheduled_for <= $1
     ORDER BY scheduled_for
     LIMIT $2`,
    [now, batchSize],
  );
  return res.rows as NotificationRow[];
}

export async function markNotificationStatus(
  db: Db,
  id: string,
  status: NotificationStatus,
  extra?: { sentAt?: Date; deliveredAt?: Date; error?: string },
): Promise<void> {
  const fields: string[] = ['status'];
  const values: unknown[] = [status];
  if (extra?.sentAt) {
    fields.push('sent_at');
    values.push(extra.sentAt);
  }
  if (extra?.deliveredAt) {
    fields.push('delivered_at');
    values.push(extra.deliveredAt);
  }
  if (extra?.error !== undefined) {
    fields.push('error');
    values.push(extra.error);
  }
  const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  await db.query(`UPDATE notifications SET ${set} WHERE id = $1`, [id, ...values]);
}

export async function markOpened(db: Db, id: string, now: Date): Promise<void> {
  await db.query(`UPDATE notifications SET opened_at = $2 WHERE id = $1`, [id, now]);
}

export async function listMemberNotifications(
  db: Db,
  memberId: string,
  filters: { status?: NotificationStatus; channel?: NotificationChannel; unreadOnly?: boolean; limit: number; cursor?: string },
): Promise<NotificationRow[]> {
  const conditions = ['member_id = $1'];
  const params: unknown[] = [memberId];
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.channel) {
    params.push(filters.channel);
    conditions.push(`channel = $${params.length}`);
  }
  if (filters.unreadOnly) {
    conditions.push("opened_at IS NULL AND channel = 'push'");
  }
  let cursorCond = '';
  if (filters.cursor) {
    cursorCond = `AND (scheduled_for, id) < ($${params.length + 1}, $${params.length + 2})`;
    params.push(filters.cursor.split(':')[0], filters.cursor.split(':')[1]);
  }
  const limit = filters.limit;
  const res = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM notifications
     WHERE ${conditions.join(' AND ')} ${cursorCond}
     ORDER BY scheduled_for DESC, id DESC
     LIMIT $${params.length + 1}`,
    [...params, limit + 1],
  );
  return res.rows as NotificationRow[];
}

export async function listAdminNotifications(
  db: Db,
  filters: { period?: string; memberId?: string; template?: string; limit: number; cursor?: string },
): Promise<NotificationRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.period) {
    params.push(filters.period);
    conditions.push(`to_char(scheduled_for AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') = $${params.length}`);
  }
  if (filters.memberId) {
    params.push(filters.memberId);
    conditions.push(`member_id = $${params.length}`);
  }
  if (filters.template) {
    params.push(filters.template);
    conditions.push(`template = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  let cursorCond = '';
  if (filters.cursor) {
    cursorCond = `AND (scheduled_for, id) < ($${params.length + 1}, $${params.length + 2})`;
    params.push(filters.cursor.split(':')[0], filters.cursor.split(':')[1]);
  }
  const res = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM notifications
     ${where} ${cursorCond}
     ORDER BY scheduled_for DESC, id DESC
     LIMIT $${params.length + 1}`,
    [...params, filters.limit + 1],
  );
  return res.rows as NotificationRow[];
}

export async function selectFallbackCandidates(
  db: Db,
  before: Date,
): Promise<NotificationRow[]> {
  const res = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM notifications n
     WHERE n.channel = 'push'
       AND n.status = 'sent'
       AND n.sent_at <= $1
       AND n.opened_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM notifications s
         WHERE s.member_id = n.member_id
           AND s.template = n.template
           AND s.channel = 'sms'
           AND (s.payload->>'fallbackFrom')::text = n.id::text
       )
     ORDER BY n.sent_at`,
    [before],
  );
  return res.rows as NotificationRow[];
}

export async function memberHasUnopenedWithin(
  db: Db,
  memberId: string,
  template: string,
  since: Date,
): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM notifications
     WHERE member_id = $1 AND template = $2 AND channel = 'push'
       AND status = 'sent' AND sent_at > $3 AND opened_at IS NULL
     LIMIT 1`,
    [memberId, template, since],
  );
  return (res.rowCount ?? 0) > 0;
}
