import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  activateSchema,
  activationModeSchema,
  loginSchema,
  pinChangeSchema,
  refreshSchema,
  totpVerifySchema,
  uuidSchema,
} from '@barakah/shared';
import { audit } from '../lib/audit';
import {
  WRITABLE_MEMBER_STATUSES,
  requireAuth,
  type Guards,
} from '../auth/guards';
import {
  activate,
  changePin,
  issueActivationCode,
  issueMemberPin,
  listDeviceEvents,
  listDevices,
  login,
  logout,
  refresh,
  revokeOwnDevice,
  totpEnroll,
  totpVerify,
  unlockUser,
  STEP_UP_TTL_MS,
  type AuthDeps,
} from '../auth/service';

const idParams = z.object({ id: uuidSchema });

export function authRoutes(deps: AuthDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    // Auth endpoints are brute-force targets: strict per-IP limit, on top of the PIN lockout.
    const strictLimit = {
      rateLimit: { max: deps.env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
    };

    app.post('/auth/activate', { config: strictLimit, schema: { body: activateSchema } }, (req) =>
      activate(deps, req.body, { ip: req.ip }),
    );

    app.post('/auth/login', { config: strictLimit, schema: { body: loginSchema } }, (req) =>
      login(deps, req.body, { ip: req.ip }),
    );

    app.post('/auth/refresh', { config: strictLimit, schema: { body: refreshSchema } }, (req) =>
      refresh(deps, req.body),
    );

    app.post('/auth/logout', { preHandler: authenticate }, async (req, reply) => {
      await logout(deps, requireAuth(req), { ip: req.ip });
      return reply.status(204).send();
    });

    app.post('/auth/totp/enroll', { preHandler: authenticate, config: strictLimit }, (req) =>
      totpEnroll(deps, requireAuth(req), { ip: req.ip }),
    );

    app.post(
      '/auth/totp/verify',
      { preHandler: authenticate, config: strictLimit, schema: { body: totpVerifySchema } },
      (req) => totpVerify(deps, requireAuth(req), req.body.code, { ip: req.ip }),
    );

    app.get('/me', { preHandler: authenticate }, async (req) => {
      const u = requireAuth(req);
      const m = await deps.pool.query(`SELECT notify_prefs FROM members WHERE id=$1`, [u.member_id]);
      const stepUpUntil = u.step_up_at ? new Date(u.step_up_at.getTime() + STEP_UP_TTL_MS) : null;
      return {
        id: u.id,
        member_id: u.member_id,
        member_code: u.member_code,
        full_name: u.full_name,
        roles: u.roles,
        member_status: u.member_status,
        read_only: !WRITABLE_MEMBER_STATUSES.includes(u.member_status),
        totp_enabled: u.totp_enabled,
        step_up_until:
          stepUpUntil && stepUpUntil > deps.clock.now() ? stepUpUntil.toISOString() : null,
        device_id: u.device_id,
        notify_prefs: (m.rows[0] as { notify_prefs: unknown } | undefined)?.notify_prefs ?? {},
      };
    });

    // Device and security views are sensitive reads (spec 19.4), so each one leaves an audit row.
    app.get('/me/devices', { preHandler: authenticate }, async (req) => {
      const u = requireAuth(req);
      await audit(deps.pool, {
        actor: u.id,
        action: 'security.view_devices',
        entityType: 'user',
        entityId: u.id,
        ip: req.ip,
        deviceId: u.device_id,
      });
      return { items: await listDevices(deps.pool, u.id, u.device_id) };
    });

    app.delete(
      '/me/devices/:id',
      { preHandler: authenticate, schema: { params: idParams } },
      async (req, reply) => {
        await revokeOwnDevice(deps, requireAuth(req), req.params.id, { ip: req.ip });
        return reply.status(204).send();
      },
    );

    app.get('/device-events', { preHandler: authenticate }, async (req) => {
      const u = requireAuth(req);
      await audit(deps.pool, {
        actor: u.id,
        action: 'security.view_device_events',
        entityType: 'device_events',
        ip: req.ip,
        deviceId: u.device_id,
      });
      return { items: await listDeviceEvents(deps.pool, 100) };
    });

    app.post(
      '/members/:id/activation-code',
      {
        preHandler: [authenticate, requireRole('cashier'), requireStepUp],
        schema: { params: idParams, body: z.object({ mode: activationModeSchema }).default({}) },
      },
      (req) =>
        issueActivationCode(deps.pool, deps, req.params.id, req.body.mode, requireAuth(req).id, {
          ip: req.ip,
          deviceId: requireAuth(req).device_id,
        }),
    );

    app.post(
      '/members/:id/pin',
      {
        preHandler: [authenticate, requireRole('cashier'), requireStepUp],
        schema: { params: idParams },
      },
      (req) =>
        issueMemberPin(deps, requireAuth(req), req.params.id, { ip: req.ip }),
    );

    app.post(
      '/auth/pin/change',
      { preHandler: authenticate, config: strictLimit, schema: { body: pinChangeSchema } },
      async (req, reply) => {
        await changePin(deps, requireAuth(req), req.body, { ip: req.ip });
        return reply.status(204).send();
      },
    );

    app.post(
      '/members/:id/unlock',
      { preHandler: [authenticate, requireRole('cashier')], schema: { params: idParams } },
      async (req, reply) => {
        await unlockUser(deps, requireAuth(req), req.params.id, { ip: req.ip });
        return reply.status(204).send();
      },
    );
  };
}
