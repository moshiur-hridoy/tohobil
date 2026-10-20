import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { auditLogQuerySchema, ledgerQuerySchema } from '@barakah/shared';
import type { Guards } from '../auth/guards';
import { listAuditLog } from '../audit/queries';
import { listLedger, verifyLedger } from '../ledger/queries';

/**
 * Read-only ledger and audit routes (spec 7). The ledger is open to every logged-in member
 * (transparency); the audit log is for the cashier and the auditor.
 * Ledger rows are only ever written by the posting service, inside the transaction of the business
 * action that causes them (a confirmed payment, received rent, ...): there is no "post an entry" route.
 */
export function ledgerRoutes(deps: { pool: pg.Pool }, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole } = guards;

    app.get(
      '/ledger',
      { preHandler: authenticate, schema: { querystring: ledgerQuerySchema } },
      (req) => listLedger(deps.pool, req.query),
    );

    // Walks every row, so keep it from being hammered.
    app.get(
      '/ledger/verify',
      { preHandler: authenticate, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
      () => verifyLedger(deps.pool),
    );

    app.get(
      '/audit-log',
      {
        preHandler: [authenticate, requireRole('cashier', 'auditor')],
        schema: { querystring: auditLogQuerySchema },
      },
      (req) => listAuditLog(deps.pool, req.query),
    );
  };
}
