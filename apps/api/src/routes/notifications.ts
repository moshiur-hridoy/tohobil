import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { Clock } from '@barakah/shared';
import {
  deviceRegisterSchema,
  notificationsQuerySchema,
  nudgeSchema,
  adminNotificationsQuerySchema,
  type DeviceRegister,
} from '@barakah/shared';
import type { Guards } from '../auth/guards';
import { requireAuth } from '../auth/guards';
import { AppError, forbidden, notFound } from '../lib/errors';
import * as repo from '../notifications/repo';
import { listInbox, openNotification, type InboxDeps } from '../notifications/inbox';
import { listAdminNotifications, listUnreachableByPush, type AdminDeps } from '../notifications/admin';
import { notifyMember, type NotificationDeps } from '../notifications/service';
import { TEMPLATE_META } from '../notifications/catalog';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';

export interface NotificationRouteDeps {
  pool: pg.Pool;
  clock: Clock;
  appVersionDefaults: { min: string; latest: string; download_url: string };
  pushSender: PushSender;
  smsProvider: SmsProvider;
  /** The VAPID public key the browser needs to subscribe; null when browser push is off. */
  vapidPublicKey?: string | null;
}

export function notificationRoutes(deps: NotificationRouteDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireWritable } = guards;

    const inboxDeps: InboxDeps = { pool: deps.pool, clock: deps.clock };
    const adminDeps: AdminDeps = { pool: deps.pool, clock: deps.clock };

    app.get('/app/version', async () => {
      const values = await deps.pool.query(`SELECT key, value FROM settings WHERE key IN ('app_min_version','app_latest_version','apk_download_url')`);
      const map = new Map(values.rows.map((r: Record<string, unknown>) => [r.key as string, r.value]));
      const validVersion = (v: unknown) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : undefined;
      const validUrl = (v: unknown) => typeof v === 'string' && v ? v : undefined;
      return {
        min: validVersion(map.get('app_min_version')) ?? deps.appVersionDefaults.min,
        latest: validVersion(map.get('app_latest_version')) ?? deps.appVersionDefaults.latest,
        download_url: validUrl(map.get('apk_download_url')) ?? deps.appVersionDefaults.download_url,
      };
    });

    // The key a browser needs to subscribe for push (it is public by design).
    app.get('/push/public-key', { preHandler: authenticate }, async () => ({
      key: deps.vapidPublicKey ?? null,
    }));

    // Register or update an FCM token, a browser push subscription, or the push preference of this device.
    app.post(
      '/devices',
      { preHandler: authenticate, schema: { body: deviceRegisterSchema } },
      async (req, reply) => {
        const user = requireAuth(req);
        const body = req.body as DeviceRegister;
        // A browser subscription is kept as its JSON text in the same column (a token starting with `{`).
        const token = body.web_push ? JSON.stringify(body.web_push) : (body.fcm_token ?? null);
        await deps.pool.query(
          `UPDATE devices
           SET fcm_token = COALESCE($2, fcm_token),
               push_enabled = COALESCE($3, push_enabled)
           WHERE id = $1 AND revoked_at IS NULL`,
          [user.device_id, token, body.push_enabled ?? null],
        );
        return reply.status(204).send();
      },
    );

    app.delete('/devices/:id', { preHandler: authenticate }, async (req, reply) => {
      const user = requireAuth(req);
      const { id } = req.params as { id: string };
      const res = await deps.pool.query(
        `UPDATE devices SET revoked_at = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [id, user.id, deps.clock.now()],
      );
      if (!(res.rowCount ?? 0)) throw notFound('device.not_found', 'Device not found');
      return reply.status(204).send();
    });

    // In-app inbox.
    app.get(
      '/notifications',
      { preHandler: authenticate, schema: { querystring: notificationsQuerySchema } },
      async (req) => {
        const user = requireAuth(req);
        const q = req.query;
        return listInbox(inboxDeps, user.member_id, {
          status: q.status,
          channel: q.channel,
          unreadOnly: q.unread_only,
          limit: q.limit,
          cursor: q.cursor,
        });
      },
    );

    app.post('/notifications/:id/open', { preHandler: authenticate }, async (req, reply) => {
      const user = requireAuth(req);
      const { id } = req.params as { id: string };
      const ok = await openNotification(inboxDeps, user.member_id, id);
      if (!ok) throw forbidden('notification.not_yours', 'Notification not found');
      return reply.status(204).send();
    });

    // Admin notification views (cashier + auditor).
    app.get(
      '/notifications/admin',
      { preHandler: [authenticate, requireRole('cashier', 'auditor')], schema: { querystring: adminNotificationsQuerySchema } },
      async (req) => {
        const q = req.query;
        return listAdminNotifications(adminDeps, {
          period: q.period,
          memberId: q.member_id,
          template: q.template,
          limit: q.limit,
          cursor: q.cursor,
        });
      },
    );

    app.get(
      '/notifications/admin/unreachable',
      { preHandler: [authenticate, requireRole('cashier', 'auditor')] },
      async () => listUnreachableByPush(adminDeps),
    );

    // Manual nudge: rate limited to one per member per template per 6 hours.
    app.post(
      '/notifications/nudge',
      { preHandler: [authenticate, requireRole('cashier'), requireWritable], schema: { body: nudgeSchema } },
      async (req, reply) => {
        const user = requireAuth(req);
        const body = req.body;
        const sixHoursAgo = new Date(deps.clock.now().getTime() - 6 * 3600_000);
        const recent = await repo.memberHasUnopenedWithin(
          deps.pool,
          body.member_id,
          body.template,
          sixHoursAgo,
        );
        if (recent) {
          throw new AppError(429, 'notification.nudge_rate_limited', 'A nudge was recently sent to this member');
        }
        const meta = TEMPLATE_META[body.template];
        if (!meta?.roleRecipients?.includes('member')) {
          throw new AppError(400, 'notification.invalid_nudge', 'This template cannot be sent as a manual nudge');
        }
        const memberRes = await deps.pool.query(
          `SELECT full_name FROM members WHERE id = $1`,
          [body.member_id],
        );
        const member = memberRes.rows[0] as { full_name: string } | undefined;
        if (!member) throw notFound('member.not_found', 'Member not found');

        const notificationDeps: NotificationDeps = {
          pool: deps.pool,
          clock: deps.clock,
          log: req.log as unknown as Logger,
          pushSender: deps.pushSender,
          smsProvider: deps.smsProvider,
        };
        await notifyMember(notificationDeps, deps.pool, {
          memberId: body.member_id,
          template: body.template,
          vars: { name: member.full_name },
          actor: user,
        });
        return reply.status(204).send();
      },
    );
  };
}
