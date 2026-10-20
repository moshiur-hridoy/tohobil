import { bn, type Clock } from '@barakah/shared';
import type { Db } from '../lib/tx';
import { dedupeKey, renderNotification, TEMPLATE_META } from './catalog';
import * as repo from './repo';

export type DeviceEventKind = 'registered' | 'revoked' | 'reset';

/**
 * Every device event goes to the auditor as a push (spec 19.1): the control against a cashier
 * activating someone else's account. Queued in the caller's transaction, so the event and its alert
 * commit together; the send-notifications worker delivers it. Quiet hours still apply (spec 10).
 */
export async function queueAuditorDeviceAlert(
  db: Db,
  clock: Clock,
  userId: string,
  kind: DeviceEventKind,
): Promise<void> {
  const res = await db.query(
    `SELECT a.member_id AS auditor_member_id, m.code, m.full_name
     FROM users s
     JOIN members m ON m.id = s.member_id
     JOIN users a ON 'auditor' = ANY (a.roles) AND a.status <> 'disabled'
     WHERE s.id = $1`,
    [userId],
  );
  const row = res.rows[0] as { auditor_member_id: string; code: string; full_name: string } | undefined;
  if (!row) return; // no auditor yet (fresh install)

  const now = clock.now();
  const event = (bn.menu.deviceEvent as Record<string, string>)[kind] ?? kind;
  const vars = { code: row.code, name: row.full_name, event };
  const rendered = renderNotification('device_event', vars);
  const payload: Record<string, unknown> = { ...vars, kind, sent_on: clock.todayDhaka(), _body: rendered.body };
  const label = `${userId}:${kind}:${now.getTime()}`;
  const meta = TEMPLATE_META.device_event;
  await repo.queueForMember(
    db,
    row.auditor_member_id,
    'device_event',
    [...meta.channels],
    payload,
    dedupeKey('device_event', row.auditor_member_id, label),
    now,
  );
}
