import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { type Clock, charityQuerySchema, charityStatementQuerySchema } from '@barakah/shared';
import type { Guards } from '../auth/guards';
import { listCharityDonations, charityStatement, listFundExpenses, type CharityDeps } from '../charity/service';

export interface CharityRouteDeps {
  pool: pg.Pool;
  clock: Clock;
}

export function charityRoutes(deps: CharityRouteDeps, guards: Guards) {
  const serviceDeps: CharityDeps = { pool: deps.pool, clock: deps.clock };

  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole } = guards;

    app.get(
      '/charity/donations',
      { preHandler: [authenticate], schema: { querystring: charityQuerySchema } },
      async (req) => {
        const out = await listCharityDonations(serviceDeps.pool, req.query.from, req.query.to);
        return out;
      },
    );

    app.get(
      '/charity/statement',
      { preHandler: [authenticate, requireRole('cashier', 'auditor')], schema: { querystring: charityStatementQuerySchema } },
      async (req) => charityStatement(serviceDeps.pool, req.query.year),
    );

    app.get(
      '/charity/expenses',
      { preHandler: [authenticate, requireRole('cashier', 'auditor')] },
      async () => listFundExpenses(serviceDeps.pool),
    );
  };
}
