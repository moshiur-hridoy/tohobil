import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  memberContactUpdateSchema,
  memberListQuerySchema,
  memberUpdateSchema,
  shareHoldingsQuerySchema,
  uuidSchema,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import {
  getMember,
  listMembers,
  listShareHoldings,
  listShareRegister,
  updateMemberContact,
  updateOwnProfile,
  type MemberDeps,
} from '../members/service';

const idParams = z.object({ id: uuidSchema });

/** Members, share register and share holdings (spec 7). Every route needs a logged-in user. */
export function memberRoutes(deps: MemberDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole } = guards;

    app.get(
      '/members',
      { preHandler: authenticate, schema: { querystring: memberListQuerySchema } },
      (req) => listMembers(deps, requireAuth(req), req.query),
    );

    app.get('/members/:id', { preHandler: authenticate, schema: { params: idParams } }, (req) =>
      getMember(deps, requireAuth(req), req.params.id),
    );

    app.patch(
      '/members/me',
      { preHandler: authenticate, schema: { body: memberUpdateSchema } },
      (req) => updateOwnProfile(deps, requireAuth(req), req.body, { ip: req.ip }),
    );

    app.patch(
      '/members/:id/contact',
      {
        preHandler: [authenticate, requireRole('cashier')],
        schema: { params: idParams, body: memberContactUpdateSchema },
      },
      (req) => updateMemberContact(deps, requireAuth(req), req.params.id, req.body, { ip: req.ip }),
    );

    app.get('/share-register', { preHandler: authenticate }, () => listShareRegister(deps.pool));

    app.get(
      '/share-holdings',
      { preHandler: authenticate, schema: { querystring: shareHoldingsQuerySchema } },
      (req) => listShareHoldings(deps, req.query),
    );
  };
}
