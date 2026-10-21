import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { financingPaySchema, levyRemitSchema, uuidSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import {
  levySummary,
  listFinancing,
  payFinancingInstalment,
  remitLevy,
  specialSummary,
  type ObligationDeps,
} from '../obligations/service';

const idParams = z.object({ id: uuidSchema });

/** Levy money held for the registrar, special contributions and deferred-purchase instalments (spec 18.7). Members read; the cashier pays. */
export function obligationRoutes(deps: ObligationDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];
    const actor = (req: Parameters<typeof requireAuth>[0]) => {
      const user = requireAuth(req);
      return { userId: user.id, ip: req.ip, deviceId: user.device_id };
    };

    app.get('/levy', { preHandler: authenticate }, () => levySummary(deps.pool));

    app.post(
      '/levy/remittances',
      { preHandler: cashierStepUp, schema: { body: levyRemitSchema } },
      (req) => remitLevy(deps, actor(req), req.body),
    );

    app.get('/special-contributions', { preHandler: authenticate }, () => specialSummary(deps.pool));

    app.get('/financing', { preHandler: authenticate }, () => listFinancing(deps.pool));

    app.post(
      '/financing/instalments/:id/pay',
      { preHandler: cashierStepUp, schema: { params: idParams, body: financingPaySchema } },
      (req) => payFinancingInstalment(deps, actor(req), req.params.id, req.body),
    );
  };
}
