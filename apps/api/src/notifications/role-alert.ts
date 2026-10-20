import type { Clock } from '@barakah/shared';
import type { Db } from '../lib/tx';
import { dedupeKey, renderNotification, TEMPLATE_META, type NotificationTemplate } from './catalog';
import * as repo from './repo';

/**
 * Queue one notification for every active holder of a role (cashier, auditor), in the caller's
 * transaction. `label` keeps a repeated event from producing duplicates (spec 10).
 */
export async function queueRoleAlert(
  db: Db,
  clock: Clock,
  roles: Array<'cashier' | 'auditor'>,
  template: NotificationTemplate,
  vars: Record<string, string>,
  label: string,
): Promise<void> {
  const res = await db.query(
    `SELECT DISTINCT u.member_id FROM users u WHERE u.status <> 'disabled' AND u.roles && $1::text[]`,
    [roles],
  );
  const rendered = renderNotification(template, vars);
  const payload: Record<string, unknown> = { ...vars, sent_on: clock.todayDhaka(), _body: rendered.body };
  for (const row of res.rows as Array<{ member_id: string }>) {
    await repo.queueForMember(
      db,
      row.member_id,
      template,
      [...TEMPLATE_META[template].channels],
      payload,
      dedupeKey(template, row.member_id, label),
      clock.now(),
    );
  }
}
