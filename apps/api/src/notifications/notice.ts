import { randomUUID } from 'node:crypto';
import type { CustomNoticeInput } from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { audit } from '../lib/audit';
import { AppError } from '../lib/errors';
import { inTransaction } from '../lib/tx';
import { notifyMember, type NotificationDeps } from './service';

/** Members who can still read a notice: everyone in the fund, suspended included, not those who left. */
const REACHABLE_STATUSES = ['active', 'warning', 'suspended'];

/**
 * The cashier's own notice (ASSUMPTIONS 123): a title and a message to every member, or to the members
 * picked. Push always; SMS only when ticked, and then to everyone picked (SMS is off for members by
 * default, so honouring that would reach almost nobody; the form says SMS costs money). Quiet hours
 * apply like any other notice (sent at night, it goes out at 08:00). The full text is in the audit log.
 */
export async function sendCustomNotice(
  deps: NotificationDeps,
  user: AuthUser,
  input: CustomNoticeInput,
  ip?: string,
): Promise<{ id: string; recipients: number }> {
  const noticeId = randomUUID();
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `SELECT m.id FROM members m JOIN users u ON u.member_id = m.id
       WHERE m.status = ANY($1::text[]) AND u.status <> 'disabled'
         AND ($2::boolean OR m.id = ANY($3::uuid[]))
       ORDER BY m.code`,
      [REACHABLE_STATUSES, input.audience === 'all', input.member_ids],
    );
    const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) throw new AppError(400, 'notification.no_recipients', 'None of the chosen members can receive a notice');

    for (const memberId of ids) {
      await notifyMember(deps, tx, {
        memberId,
        template: 'custom_notice',
        vars: { title: input.title, message: input.message },
        dedupeLabel: noticeId,
        channels: input.sms ? ['push', 'sms'] : ['push'],
        // SMS is off for members by default, so a ticked SMS goes to everyone picked.
        ignoreSmsOptOut: input.sms,
        actor: user,
      });
    }
    await audit(tx, {
      actor: user.id,
      action: 'notification.custom_notice',
      entityType: 'notification',
      entityId: noticeId,
      after: { title: input.title, message: input.message, audience: input.audience, recipients: ids.length, sms: input.sms },
      ip,
      deviceId: user.device_id,
    });
    return { id: noticeId, recipients: ids.length };
  });
}
