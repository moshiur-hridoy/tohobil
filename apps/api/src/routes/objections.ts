import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  objectionCreateSchema,
  objectionResolveSchema,
  objectionsQuerySchema,
  uuidSchema,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { withIdempotency } from '../lib/idempotency';
import {
  createObjection,
  listObjections,
  resolveObjection,
  type ObjectionDeps,
} from '../objections/service';

const idParams = z.object({ id: uuidSchema });

/** Objections to ledger rows (spec 5.12, 7): any active member creates, the auditor resolves. */
export function objectionRoutes(deps: ObjectionDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireWritable } = guards;

    app.post(
      '/objections',
      { preHandler: [authenticate, requireWritable], schema: { body: objectionCreateSchema } },
      (req, reply) => {
        const user = requireAuth(req);
        return withIdempotency(deps, req, reply, user.id, JSON.stringify(req.body), async () => ({
          status: 201,
          body: await createObjection(deps, user, req.body, { ip: req.ip }),
        }));
      },
    );

    app.get(
      '/objections',
      { preHandler: authenticate, schema: { querystring: objectionsQuerySchema } },
      (req) => listObjections(deps, req.query),
    );

    app.patch(
      '/objections/:id',
      {
        preHandler: [authenticate, requireRole('auditor')],
        schema: { params: idParams, body: objectionResolveSchema },
      },
      (req) => resolveObjection(deps, requireAuth(req), req.params.id, req.body, { ip: req.ip }),
    );
  };
}
