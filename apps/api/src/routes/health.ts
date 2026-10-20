import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbHandle } from '../lib/db';

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  timestamp: z.string(),
  db: z.enum(['connected', 'disconnected']),
  version: z.string(),
});

const DB_CHECK_TIMEOUT_MS = 2_000;

async function checkDb(db: DbHandle): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('db check timed out')), DB_CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/v1/health: public liveness plus a real database check (spec 7). Returns 503 when the
 * database is unreachable so container healthchecks and uptime monitors actually fail.
 */
export function healthRoutes(db: DbHandle, version: string) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get(
      '/health',
      {
        // Polled every 30 s by the container healthcheck and external monitors: never rate limit.
        config: { rateLimit: false },
        schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } },
      },
      async (_request, reply) => {
        const connected = await checkDb(db);
        return reply.status(connected ? 200 : 503).send({
          status: connected ? 'ok' : 'degraded',
          timestamp: new Date().toISOString(),
          db: connected ? 'connected' : 'disconnected',
          version,
        });
      },
    );
  };
}
