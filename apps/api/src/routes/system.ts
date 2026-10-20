import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, type Guards } from '../auth/guards';
import { unauthorized } from '../lib/errors';
import { confirmOfflineCopy, raiseBackupAlert, systemStatus, type SystemDeps } from '../system/status';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export interface SystemRouteDeps extends SystemDeps {
  alertSecret: string;
}

/** Backup and health visibility for the cashier and auditor, and the sidecar's failure alert (spec 12). */
export function systemRoutes(deps: SystemRouteDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;

    app.get('/system/status', { preHandler: [authenticate, requireRole('cashier', 'auditor')] }, () => systemStatus(deps));

    app.post('/system/offline-copy', { preHandler: [authenticate, requireRole('cashier'), requireStepUp] }, async (req, reply) => {
      await confirmOfflineCopy(deps, requireAuth(req).id, req.ip);
      return reply.status(204).send();
    });

    // Called by the backup sidecar, which has no user session: it proves itself with the shared secret.
    app.post(
      '/internal/alert',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { body: z.object({ job: z.string().trim().min(1).max(60) }) },
      },
      async (req, reply) => {
        const given = req.headers['x-alert-secret'];
        if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(deps.alertSecret))) throw unauthorized();
        await raiseBackupAlert(deps.pool, deps.clock, req.body.job);
        return reply.status(204).send();
      },
    );
  };
}
