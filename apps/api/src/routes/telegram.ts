import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { telegramConnectSchema, telegramEnableSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import type { TelegramService } from '../telegram/service';

/**
 * Telegram approvals (docs/ASSUMPTIONS.md 101). The settings routes are cashier-only; changing
 * anything needs the authenticator code. The webhook is public but answers only to the secret that
 * Telegram was given when the bot was connected.
 */
export function telegramRoutes(telegram: TelegramService, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    const cashier = [authenticate, requireRole('cashier')];
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];

    app.get('/telegram', { preHandler: cashier }, () => telegram.status());

    app.post(
      '/telegram/token',
      { preHandler: cashierStepUp, schema: { body: telegramConnectSchema } },
      (req) => telegram.connect(requireAuth(req), req.body.token, { ip: req.ip }),
    );

    app.post('/telegram/link-code', { preHandler: cashierStepUp }, (req) =>
      telegram.createLinkCode(requireAuth(req), { ip: req.ip }),
    );

    app.patch(
      '/telegram',
      { preHandler: cashierStepUp, schema: { body: telegramEnableSchema } },
      (req) => telegram.setEnabled(requireAuth(req), req.body.enabled, { ip: req.ip }),
    );

    app.post('/telegram/test', { preHandler: cashier }, async (_req, reply) => {
      await telegram.sendTest();
      return reply.status(204).send();
    });

    app.delete('/telegram', { preHandler: cashierStepUp }, async (req, reply) => {
      await telegram.disconnect(requireAuth(req), { ip: req.ip });
      return reply.status(204).send();
    });

    app.post('/telegram/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (!(await telegram.verifySecret(typeof header === 'string' ? header : undefined))) {
        return reply.status(401).send({ ok: false });
      }
      // Telegram retries anything but a 200, so every handled or failed update is answered 200.
      await telegram.handleUpdate((req.body ?? {}) as Parameters<TelegramService['handleUpdate']>[0]);
      return { ok: true };
    });
  };
}
