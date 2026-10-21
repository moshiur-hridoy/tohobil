import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { z } from 'zod';
import { meetingAttendanceSchema, meetingCancelSchema, meetingScheduleSchema, uuidSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import type { AuthUser } from '../auth/service';
import { createLogger } from '../lib/logger';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import {
  cancelMeeting,
  createMeeting,
  getMeeting,
  listMeetings,
  nextMeeting,
  recordAttendance,
  scheduleMeeting,
  type MeetingActor,
  type MeetingDeps,
} from '../meetings/service';

const idParams = z.object({ id: uuidSchema });

export interface MeetingRouteDeps extends MeetingDeps {
  pushSender: PushSender;
  smsProvider: SmsProvider;
  log?: Logger;
}

function actorFrom(user: AuthUser, req: FastifyRequest): MeetingActor {
  return { userId: user.id, ip: req.ip, deviceId: user.device_id };
}

/** Monthly meetings (constitution 9): everyone can see them; the cashier schedules and marks attendance. */
export function meetingRoutes(deps: MeetingRouteDeps, guards: Guards) {
  const notifications = {
    pool: deps.pool,
    clock: deps.clock,
    log: deps.log ?? createLogger('silent'),
    pushSender: deps.pushSender,
    smsProvider: deps.smsProvider,
  };

  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole } = guards;
    const cashier = [authenticate, requireRole('cashier')];

    app.get('/meetings', { preHandler: authenticate }, async () => ({ items: await listMeetings(deps.pool) }));

    app.get('/meetings/next', { preHandler: authenticate }, async () => ({
      meeting: await nextMeeting(deps.pool, deps.clock.now()),
    }));

    app.get('/meetings/:id', { preHandler: authenticate, schema: { params: idParams } }, async (req) =>
      getMeeting(deps.pool, req.params.id),
    );

    app.post('/meetings', { preHandler: cashier, schema: { body: meetingScheduleSchema } }, async (req) => {
      const id = await createMeeting(deps, actorFrom(requireAuth(req), req), req.body);
      return getMeeting(deps.pool, id);
    });

    app.patch(
      '/meetings/:id',
      { preHandler: cashier, schema: { params: idParams, body: meetingScheduleSchema } },
      async (req) => {
        await scheduleMeeting(deps, actorFrom(requireAuth(req), req), req.params.id, req.body);
        return getMeeting(deps.pool, req.params.id);
      },
    );

    app.post(
      '/meetings/:id/cancel',
      { preHandler: cashier, schema: { params: idParams, body: meetingCancelSchema } },
      async (req) => {
        await cancelMeeting(deps, actorFrom(requireAuth(req), req), req.params.id, req.body.reason);
        return getMeeting(deps.pool, req.params.id);
      },
    );

    app.post(
      '/meetings/:id/attendance',
      { preHandler: cashier, schema: { params: idParams, body: meetingAttendanceSchema } },
      async (req) => {
        await recordAttendance({ ...deps, notifications }, actorFrom(requireAuth(req), req), req.params.id, req.body);
        return getMeeting(deps.pool, req.params.id);
      },
    );
  };
}
