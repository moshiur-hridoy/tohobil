import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { auditLogQuerySchema, entryRemarkCreateSchema, ledgerQuerySchema, ledgerSeqParamsSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { listAuditLog } from '../audit/queries';
import { listLedger, verifyLedger } from '../ledger/queries';
import { addEntryRemark, listEntryRemarks } from '../ledger/remarks';

/**
 * Read-only ledger and audit routes (spec 7). The ledger is open to every logged-in member
 * (transparency); the audit log is for the cashier and the auditor.
 * Ledger rows are only ever written by the posting service, inside the transaction of the business
 * action that causes them (a confirmed payment, received rent, ...): there is no "post an entry" route.
 * A remark on an entry lives in its own append-only table and never touches the entry.
 */
export function ledgerRoutes(deps: { pool: pg.Pool }, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireWritable } = guards;

    app.get(
      '/ledger',
      { preHandler: authenticate, schema: { querystring: ledgerQuerySchema } },
      (req) => listLedger(deps.pool, req.query, requireAuth(req)),
    );

    // Remarks written afterwards on an entry (ASSUMPTIONS 128). They never change the entry itself.
    app.get(
      '/ledger/:seq/remarks',
      { preHandler: authenticate, schema: { params: ledgerSeqParamsSchema } },
      (req) => listEntryRemarks(deps.pool, requireAuth(req), req.params.seq),
    );

    app.post(
      '/ledger/:seq/remarks',
      {
        preHandler: [authenticate, requireWritable, requireRole('cashier', 'auditor')],
        schema: { params: ledgerSeqParamsSchema, body: entryRemarkCreateSchema },
      },
      async (req, reply) => {
        const out = await addEntryRemark(deps.pool, requireAuth(req), req.params.seq, req.body, { ip: req.ip });
        return reply.status(201).send(out);
      },
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
