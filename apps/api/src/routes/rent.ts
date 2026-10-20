import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  periodSchema,
  rentExpectedQuerySchema,
  rentReceiptSchema,
  rentStreamCreateSchema,
  rentStreamUpdateSchema,
  uuidSchema,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { notFound } from '../lib/errors';
import type { AuthUser } from '../auth/service';
import type { LedgerActor } from '../ledger/service';
import {
  createStream,
  generateExpectedRent,
  getStream,
  listExpected,
  listStreams,
  receiveRent,
  updateStream,
  type RentActor,
  type RentDeps,
} from '../rent/service';

const idParams = z.object({ id: uuidSchema });

function actorFrom(user: AuthUser, req: FastifyRequest): RentActor & LedgerActor {
  return { userId: user.id, ip: req.ip, deviceId: user.device_id };
}

export function rentRoutes(deps: RentDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    const cashier = [authenticate, requireRole('cashier')];
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];

    app.get('/rent/streams', { preHandler: authenticate }, async (req) =>
      listStreams(deps.pool, { limit: 100, cursor: (req.query as { cursor?: string }).cursor }),
    );

    app.post('/rent/streams', { preHandler: cashier, schema: { body: rentStreamCreateSchema } }, async (req) => {
      const user = requireAuth(req);
      const id = await createStream(deps, actorFrom(user, req), req.body);
      const stream = await getStream(deps.pool, id);
      if (!stream) throw notFound('rent_stream.not_found', 'Rent stream not found');
      return stream;
    });

    app.patch('/rent/streams/:id', { preHandler: cashier, schema: { params: idParams, body: rentStreamUpdateSchema } }, async (req) => {
      const user = requireAuth(req);
      await updateStream(deps, actorFrom(user, req), req.params.id, req.body);
      const stream = await getStream(deps.pool, req.params.id);
      if (!stream) throw notFound('rent_stream.not_found', 'Rent stream not found');
      return stream;
    });

    app.get('/rent/expected', { preHandler: authenticate, schema: { querystring: rentExpectedQuerySchema } }, async (req) => {
      const q = req.query;
      return listExpected(deps.pool, deps.clock, {
        period: q.period,
        stream_id: q.stream_id,
        limit: q.limit ?? 50,
        cursor: q.cursor,
      });
    });

    app.post(
      '/rent/expected/generate',
      { preHandler: cashier, schema: { body: z.object({ period: periodSchema }) } },
      async (req) => {
        const { created } = await generateExpectedRent(deps.pool, req.body.period);
        return { created };
      },
    );

    app.post(
      '/rent/expected/:id/receive',
      { preHandler: cashierStepUp, schema: { params: idParams, body: rentReceiptSchema } },
      async (req) => {
        const user = requireAuth(req);
        const { seq, received_paisa } = await receiveRent(deps, actorFrom(user, req), req.params.id, req.body);
        return { ledger_seq: seq.toString(), received_paisa: received_paisa.toString() };
      },
    );
  };
}
