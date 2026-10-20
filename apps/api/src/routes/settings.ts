import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { settingsUpdateSchema, settingReadWhitelist } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { inTransaction } from '../lib/tx';
import { audit } from '../lib/audit';

export interface SettingsRouteDeps {
  pool: pg.Pool;
}

/** Settings writes: cashier-only, step-up protected, audited (Phase 3, slice 1). */
export function settingsRoutes(deps: SettingsRouteDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;

    // Public whitelist of settings any member may read. Detailed values such as version defaults
    // are exposed through other endpoints (e.g. GET /app/version).
    app.get('/settings', { preHandler: authenticate }, async () => {
      const res = await deps.pool.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM settings WHERE key = ANY($1)`,
        [settingReadWhitelist],
      );
      const out: Record<string, unknown> = {};
      for (const row of res.rows) out[row.key] = row.value;
      return out;
    });

    app.patch(
      '/settings',
      {
        preHandler: [authenticate, requireRole('cashier'), requireStepUp],
        schema: { body: settingsUpdateSchema },
      },
      async (req, reply) => {
        const user = requireAuth(req);
        const { key, value } = req.body;
        const before = await inTransaction(deps.pool, async (db) => {
          const existing = await db.query<{ value: unknown }>(
            `SELECT value FROM settings WHERE key = $1 FOR UPDATE`,
            [key],
          );
          const old = existing.rows[0]?.value ?? null;

          await db.query(`UPDATE settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1`, [
            key,
            JSON.stringify(value),
            user.id,
          ]);

          await audit(db, {
            actor: user.id,
            action: 'settings.update',
            entityType: 'settings',
            entityId: key,
            before: old,
            after: value,
            ip: req.ip,
            deviceId: user.device_id,
          });
          return old;
        });
        return reply.status(200).send({ key, value, before });
      },
    );
  };
}
