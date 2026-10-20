import type { JobDeps } from '../index';
import { notifyMember } from '../../notifications/service';
import { makeNotificationDeps } from './send';

export async function pendingPaymentAlertJob(deps: JobDeps): Promise<{ queued: number }> {
  const { ruleInt } = await import('./util');
  const hours = await ruleInt(deps.pool, deps.clock, 'payment_pending_alert_hours', 24);
  const since = new Date(deps.clock.now().getTime() - hours * 3600_000);
  const res = await deps.pool.query(
    `SELECT count(*)::int AS n
     FROM payments
     WHERE status = 'pending' AND submitted_at < $1`,
    [since],
  );
  const count = (res.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (count === 0) return { queued: 0 };

  const cashiers = await deps.pool.query(
    `SELECT m.id FROM members m
     JOIN users u ON u.member_id = m.id
     WHERE u.status = 'active' AND 'cashier' = ANY(u.roles)`,
  );
  const ndeps = makeNotificationDeps(deps);
  for (const row of cashiers.rows as Array<{ id: string }>) {
    await notifyMember(ndeps, deps.pool, {
      memberId: row.id,
      template: 'pending_payment_alert',
      vars: {
        count: String(count),
        hours: String(hours),
      },
      dedupeLabel: deps.clock.todayDhaka(),
    });
  }
  return { queued: cashiers.rows.length };
}

export async function cashierDailySummaryJob(deps: JobDeps): Promise<{ queued: number }> {
  const unpaid = await deps.pool.query(
    `SELECT count(DISTINCT m.id)::int AS n
     FROM members m
     JOIN dues d ON d.member_id = m.id
     JOIN v_due_status v ON v.due_id = d.id
     WHERE m.status IN ('active','warning') AND v.outstanding_paisa > 0`,
  );
  const pending = await deps.pool.query(
    `SELECT count(*)::int AS n FROM payments WHERE status = 'pending'`,
  );
  const unpaidCount = (unpaid.rows[0] as { n: number } | undefined)?.n ?? 0;
  const pendingCount = (pending.rows[0] as { n: number } | undefined)?.n ?? 0;

  const recipients = await deps.pool.query(
    `SELECT m.id FROM members m
     JOIN users u ON u.member_id = m.id
     WHERE u.status = 'active' AND ('cashier' = ANY(u.roles) OR 'auditor' = ANY(u.roles))`,
  );
  const ndeps = makeNotificationDeps(deps);
  for (const row of recipients.rows as Array<{ id: string }>) {
    await notifyMember(ndeps, deps.pool, {
      memberId: row.id,
      template: 'cashier_daily_summary',
      vars: {
        unpaid_count: String(unpaidCount),
        pending_count: String(pendingCount),
      },
      dedupeLabel: deps.clock.todayDhaka(),
    });
  }
  return { queued: recipients.rows.length };
}
