import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import { type Clock, constitutionSearchQuerySchema, uuidSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import {
  type ConstitutionDeps,
  acknowledgeVersion,
  getConstitutionVersion,
  listConstitutionVersions,
  searchClauses,
} from '../constitution/service';

export interface ConstitutionRouteDeps {
  pool: pg.Pool;
  clock: Clock;
}

export function constitutionRoutes(deps: ConstitutionRouteDeps, guards: Guards) {
  const serviceDeps: ConstitutionDeps = { pool: deps.pool, clock: deps.clock };

  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireWritable } = guards;

    app.get(
      '/constitution/versions',
      { preHandler: authenticate },
      async () => listConstitutionVersions(serviceDeps.pool),
    );

    app.get(
      '/constitution/versions/:id',
      { preHandler: authenticate, schema: { params: z.object({ id: uuidSchema }) } },
      async (req) => {
        const user = requireAuth(req);
        return getConstitutionVersion(serviceDeps.pool, req.params.id, user.member_id);
      },
    );

    app.get(
      '/constitution/versions/:id/search',
      {
        preHandler: authenticate,
        schema: { params: z.object({ id: uuidSchema }), querystring: constitutionSearchQuerySchema },
      },
      async (req) => searchClauses(serviceDeps.pool, req.params.id, req.query.q),
    );

    app.post(
      '/constitution/versions/:id/ack',
      { preHandler: [authenticate, requireWritable], schema: { params: z.object({ id: uuidSchema }) } },
      async (req) => {
        const user = requireAuth(req);
        return acknowledgeVersion(serviceDeps.pool, req.params.id, user.member_id);
      },
    );
  };
}
