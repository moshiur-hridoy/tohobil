import { formatBDT } from '@barakah/shared';
import type { JobDeps } from '../index';
import { notifyMember } from '../../notifications/service';
import { fmtMonth } from '../../notifications/service';
import { makeNotificationDeps } from './send';

export async function remindDuesJob(deps: JobDeps): Promise<{ queued: number }> {
  const { ruleInt, isWindow } = await import('./util');
  const startDay = await ruleInt(deps.pool, deps.clock, 'reminder_start_day', 15);
  const endDay = await ruleInt(deps.pool, deps.clock, 'reminder_end_day', 20);
  if (!isWindow(deps.clock.now(), startDay, endDay)) {
    return { queued: 0 };
  }
  const res = await deps.pool.query(
    `SELECT m.id, m.full_name, d.period, d.due_date,
       d.amount_paisa - COALESCE(al.allocated_paisa,0) AS outstanding_paisa
     FROM members m
     JOIN dues d ON d.member_id = m.id
     JOIN v_due_status v ON v.due_id = d.id
     LEFT JOIN (
       SELECT due_id, SUM(amount_paisa) AS allocated_paisa
       FROM payment_allocations GROUP BY due_id
     ) al ON al.due_id = d.id
     WHERE m.status IN ('active','warning')
       AND v.outstanding_paisa > 0
       AND d.due_date <= today_dhaka() + 5
       AND NOT EXISTS (
         SELECT 1 FROM payments p
         WHERE p.member_id = m.id AND p.status = 'pending'
       )
     ORDER BY m.code`,
  );
  const ndeps = makeNotificationDeps(deps);
  let queued = 0;
  for (const row of res.rows as Array<{
    id: string;
    full_name: string;
    period: string;
    due_date: string;
    outstanding_paisa: string | number;
  }>) {
    const outstanding = BigInt(row.outstanding_paisa);
    await notifyMember(ndeps, deps.pool, {
      memberId: row.id,
      template: 'due_reminder',
      vars: {
        name: row.full_name,
        month: fmtMonth(row.period),
        outstanding: formatBDT(outstanding, { digits: 'bn' }),
        due_date: row.due_date,
      },
      dedupeLabel: row.period,
    });
    queued += 1;
  }
  return { queued };
}

export async function notifyFinesJob(deps: JobDeps): Promise<{ queued: number }> {
  const res = await deps.pool.query(
    `SELECT f.id, f.member_id, m.full_name, d.period, f.amount_paisa
     FROM fines f
     JOIN dues d ON d.id = f.due_id
     JOIN members m ON m.id = f.member_id
     WHERE date_trunc('day', f.created_at AT TIME ZONE 'Asia/Dhaka') = today_dhaka()
       AND f.kind = 'late_payment'`,
  );
  const ndeps = makeNotificationDeps(deps);
  let queued = 0;
  for (const row of res.rows as Array<{
    id: string;
    member_id: string;
    full_name: string;
    period: string;
    amount_paisa: string | number;
  }>) {
    const fine = BigInt(row.amount_paisa);
    const dueRes = await deps.pool.query(
      `SELECT d.amount_paisa - COALESCE(SUM(pa.amount_paisa),0) AS outstanding_paisa
       FROM dues d LEFT JOIN payment_allocations pa ON pa.due_id = d.id
       WHERE d.id = (SELECT due_id FROM fines WHERE id = $1)
       GROUP BY d.id`,
      [row.id],
    );
    const outstanding = BigInt((dueRes.rows[0] as { outstanding_paisa: string | number } | undefined)?.outstanding_paisa ?? 0);
    await notifyMember(ndeps, deps.pool, {
      memberId: row.member_id,
      template: 'fine_notice',
      vars: {
        name: row.full_name,
        month: fmtMonth(row.period),
        fine: formatBDT(fine, { digits: 'bn' }),
        total: formatBDT(outstanding, { digits: 'bn' }),
      },
      dedupeLabel: row.id,
    });
    queued += 1;
  }
  return { queued };
}
