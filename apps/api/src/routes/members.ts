import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  contactLogEntrySchema,
  memberContactUpdateSchema,
  memberListQuerySchema,
  memberUpdateSchema,
  shareHoldingsQuerySchema,
  uuidSchema,
  positivePaisaSchema,
  PAYMENT_METHODS,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { inTransaction } from '../lib/tx';
import type { LedgerActor } from '../ledger/service';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import type { Logger } from 'pino';
import {
  getMember,
  listMembers,
  listShareHoldings,
  listShareRegister,
  updateMemberContact,
  updateOwnProfile,
  type MemberDeps,
} from '../members/service';
import { reinstateMember } from '../members/status';
import { addContactLogEntry, listContactLog } from '../members/contact';
import { listSettlements, recordSettlementPayout } from '../members/settlement';

const idParams = z.object({ id: uuidSchema });

export interface MemberRouteDeps extends MemberDeps {
  pushSender: PushSender;
  smsProvider: SmsProvider;
  log?: Logger;
}

function statusDeps(deps: MemberRouteDeps) {
  return {
    pool: deps.pool,
    clock: deps.clock,
    pushSender: deps.pushSender,
    smsProvider: deps.smsProvider,
    log: deps.log,
  };
}

/** Members, share register and share holdings (spec 7). Every route needs a logged-in user. */
export function memberRoutes(deps: MemberRouteDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];

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

    app.get(
      '/members/:id/status-history',
      { preHandler: authenticate, schema: { params: idParams } },
      async (req) => {
        const rows = (
          await deps.pool.query(
            `SELECT id, from_status, to_status, reason, proposal_id, created_by, created_at
             FROM member_status_events
             WHERE member_id = $1
             ORDER BY created_at DESC, id DESC`,
            [req.params.id],
          )
        ).rows;
        return { items: rows };
      },
    );

    app.post(
      '/members/:id/contact-log',
      { preHandler: cashierStepUp, schema: { params: idParams, body: contactLogEntrySchema } },
      async (req) => {
        const user = requireAuth(req);
        return addContactLogEntry(
          deps.pool,
          req.params.id,
          req.body.kind,
          req.body.outcome ?? null,
          req.body.note ?? null,
          user.id,
        );
      },
    );

    app.get(
      '/members/:id/contact-log',
      {
        preHandler: [authenticate, requireRole('cashier')],
        schema: { params: idParams, querystring: z.object({ limit: z.coerce.number().min(1).max(200).default(50) }) },
      },
      async (req) => {
        return listContactLog(deps.pool, req.params.id, req.query.limit);
      },
    );

    app.post(
      '/members/:id/reinstate',
      { preHandler: cashierStepUp, schema: { params: idParams } },
      async (req) => {
        const user = requireAuth(req);
        await inTransaction(deps.pool, async (tx) =>
          reinstateMember(tx, statusDeps(deps), req.params.id, null, user.id),
        );
        return { id: req.params.id, status: 'active' };
      },
    );

    const settlementPayoutSchema = z.object({
      payout_id: uuidSchema,
      amount_paisa: positivePaisaSchema,
      method: z.enum(PAYMENT_METHODS),
      trx_id: z.string().trim().max(100).optional(),
      note: z.string().trim().max(500).optional(),
    });

    app.get(
      '/settlements',
      { preHandler: authenticate, schema: { querystring: z.object({ member_id: uuidSchema.optional() }) } },
      (req) => listSettlements(deps.pool, requireAuth(req), req.query.member_id),
    );

    app.post(
      '/settlements/:id/payouts',
      { preHandler: cashierStepUp, schema: { params: idParams, body: settlementPayoutSchema } },
      async (req) => {
        const user = requireAuth(req);
        const actor: LedgerActor = {
          userId: user.id,
          ip: req.ip,
          deviceId: user.device_id,
        };
        await inTransaction(deps.pool, async (tx) =>
          recordSettlementPayout(
            tx,
            statusDeps(deps),
            req.body.payout_id,
            {
              amount_paisa: BigInt(req.body.amount_paisa),
              method: req.body.method,
              trx_id: req.body.trx_id ?? null,
              note: req.body.note ?? null,
            },
            actor,
          ),
        );
        return { id: req.body.payout_id, recorded: true };
      },
    );

    app.get('/share-register', { preHandler: authenticate }, () => listShareRegister(deps.pool));

    app.get(
      '/share-holdings',
      { preHandler: authenticate, schema: { querystring: shareHoldingsQuerySchema } },
      (req) => listShareHoldings(deps, req.query),
    );
  };
}
