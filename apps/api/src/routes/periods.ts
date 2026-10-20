import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { periodSchema, reconciliationSubmitSchema, yearSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import {
  annualAuditStatus,
  approveReconciliation,
  listPeriods,
  listReconciliations,
  lockPeriod,
  requestAnnualAudit,
  signOffAnnualAudit,
  submitReconciliation,
  type PeriodActor,
  type PeriodDeps,
} from '../periods/service';
import { createAnnualArchive, type ArchiveDeps } from '../reports/annual';

const periodParams = z.object({ period: periodSchema });
const yearParams = z.object({ period: yearSchema });

function actorOf(req: FastifyRequest): PeriodActor {
  const user = requireAuth(req);
  return { userId: user.id, ip: req.ip, deviceId: user.device_id };
}

/** Month-end cash counts, period locks and the year-end audit and archive (spec 5.12, 12). */
export function periodRoutes(deps: PeriodDeps & Pick<ArchiveDeps, 'archivesDir' | 'files'>, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];
    const auditorStepUp = [authenticate, requireRole('auditor'), requireStepUp];
    const staff = [authenticate, requireRole('cashier', 'auditor')];

    app.get('/periods', { preHandler: authenticate, schema: { querystring: z.object({ year: yearSchema.optional() }) } }, (req) =>
      listPeriods(deps.pool, req.query.year),
    );

    app.get('/reconciliations', { preHandler: staff, schema: { querystring: z.object({ period: periodSchema }) } }, (req) =>
      listReconciliations(deps.pool, req.query.period),
    );

    app.post('/reconciliations', { preHandler: cashierStepUp, schema: { body: reconciliationSubmitSchema } }, (req) =>
      submitReconciliation(deps, actorOf(req), req.body),
    );

    app.post('/reconciliations/:period/approve', { preHandler: auditorStepUp, schema: { params: periodParams } }, async (req, reply) => {
      await approveReconciliation(deps, actorOf(req), req.params.period);
      return reply.status(204).send();
    });

    app.post('/periods/:period/lock', { preHandler: auditorStepUp, schema: { params: periodParams } }, async (req, reply) => {
      await lockPeriod(deps, actorOf(req), req.params.period);
      return reply.status(204).send();
    });

    // `:period` here carries a year; the route tree shares one parameter name per position.
    app.get('/periods/:period/audit', { preHandler: authenticate, schema: { params: yearParams } }, (req) =>
      annualAuditStatus(deps.pool, req.params.period),
    );

    app.post('/periods/:period/audit-request', { preHandler: cashierStepUp, schema: { params: yearParams } }, (req) =>
      requestAnnualAudit(deps, actorOf(req), req.params.period),
    );

    app.post('/periods/:period/audit-signoff', { preHandler: auditorStepUp, schema: { params: yearParams } }, async (req, reply) => {
      await signOffAnnualAudit(deps, actorOf(req), req.params.period);
      return reply.status(204).send();
    });

    app.post('/periods/:period/archive', { preHandler: cashierStepUp, schema: { params: yearParams } }, (req) =>
      createAnnualArchive(deps, actorOf(req), req.params.period),
    );
  };
}
