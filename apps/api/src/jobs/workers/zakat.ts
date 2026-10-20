import { dedupeKey, renderNotification, TEMPLATE_META } from '../../notifications/catalog';
import * as repo from '../../notifications/repo';
import type { JobDeps } from '../index';

/**
 * On the day the cashier set as `zakat_notice_date` (before Ramadan) every active member gets the
 * `zakat_info` notice pointing at their statement. Once per member per year; the system gives figures
 * only, never a religious calculation (spec 18.7).
 */
export async function zakatNoticeJob(deps: Pick<JobDeps, 'pool' | 'clock'>): Promise<{ queued: number }> {
  const today = deps.clock.todayDhaka();
  const setting = await deps.pool.query(`SELECT value FROM settings WHERE key = 'zakat_notice_date'`);
  if ((setting.rows[0] as { value: string } | undefined)?.value !== today) return { queued: 0 };

  const members = (await deps.pool.query(`SELECT id FROM members WHERE status IN ('active','warning')`)).rows as Array<{ id: string }>;
  const rendered = renderNotification('zakat_info', {});
  const payload = { sent_on: today, link: '/menu', _body: rendered.body };
  let queued = 0;
  for (const m of members) {
    const ids = await repo.queueForMember(
      deps.pool,
      m.id,
      'zakat_info',
      [...TEMPLATE_META.zakat_info.channels],
      payload,
      dedupeKey('zakat_info', m.id, today.slice(0, 4)),
      deps.clock.now(),
    );
    queued += ids.length > 0 ? 1 : 0;
  }
  return { queued };
}
