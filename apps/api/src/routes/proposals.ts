import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { z } from 'zod';
import {
  proposalCreateSchema,
  proposalExecuteSchema,
  proposalOpenSchema,
  proposalsQuerySchema,
  uuidSchema,
  voteSchema,
  type Clock,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import type { AuthUser } from '../auth/service';
import {
  cancelProposal,
  closeEarlyProposal,
  createProposal,
  executeProposal,
  getProposal,
  listProposals,
  openProposal,
  voteOnProposal,
  type ProposalDeps,
} from '../proposals/service';

export interface ProposalRouteDeps {
  pool: pg.Pool;
  clock: Clock;
}

interface ClientCtx {
  ip?: string;
  user: AuthUser;
}

function ctx(req: FastifyRequest): ClientCtx {
  return { ip: req.ip, user: requireAuth(req) };
}

export function proposalRoutes(deps: ProposalRouteDeps, guards: Guards) {
  const serviceDeps: ProposalDeps = { pool: deps.pool, clock: deps.clock };

  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireWritable, requireRole, requireStepUp } = guards;
    const privileged = [authenticate, requireRole('cashier', 'auditor')];

    app.get(
      '/proposals',
      { preHandler: authenticate, schema: { querystring: proposalsQuerySchema } },
      (req) => listProposals(serviceDeps, requireAuth(req), req.query),
    );

    app.get('/proposals/:id', { preHandler: authenticate, schema: { params: z.object({ id: uuidSchema }) } }, (req) =>
      getProposal(serviceDeps, requireAuth(req), req.params.id),
    );

    app.post(
      '/proposals',
      { preHandler: [authenticate, requireWritable], schema: { body: proposalCreateSchema } },
      (req) => createProposal(serviceDeps, requireAuth(req), req.body, ctx(req)),
    );

    app.post(
      '/proposals/:id/open',
      {
        preHandler: privileged,
        schema: { params: z.object({ id: uuidSchema }), body: proposalOpenSchema },
      },
      (req) => openProposal(serviceDeps, requireAuth(req), req.params.id, req.body, ctx(req)),
    );

    app.post(
      '/proposals/:id/close-early',
      { preHandler: privileged, schema: { params: z.object({ id: uuidSchema }) } },
      (req) => closeEarlyProposal(serviceDeps, requireAuth(req), req.params.id, ctx(req)),
    );

    app.post(
      '/proposals/:id/cancel',
      { preHandler: privileged, schema: { params: z.object({ id: uuidSchema }) } },
      (req) => cancelProposal(serviceDeps, requireAuth(req), req.params.id, ctx(req)),
    );

    app.post(
      '/proposals/:id/vote',
      {
        preHandler: [authenticate, requireWritable],
        schema: { params: z.object({ id: uuidSchema }), body: voteSchema },
      },
      (req) => voteOnProposal(serviceDeps, requireAuth(req), req.params.id, req.body, ctx(req)),
    );

    app.post(
      '/proposals/:id/execute',
      {
        preHandler: [authenticate, requireRole('cashier', 'auditor'), requireStepUp],
        schema: { params: z.object({ id: uuidSchema }), body: proposalExecuteSchema },
      },
      (req) => executeProposal(serviceDeps, requireAuth(req), req.params.id, req.body, ctx(req)),
    );
  };
}
