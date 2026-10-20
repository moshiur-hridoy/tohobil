import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  approvalDecisionSchema,
  approvalsQuerySchema,
  cashierEntrySchema,
  paymentConfirmSchema,
  paymentRejectSchema,
  paymentsQuerySchema,
  paymentSubmitSchema,
  parseSmsSchema,
  reverseRequestSchema,
  uuidSchema,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { withIdempotency } from '../lib/idempotency';
import {
  approveApproval,
  cashierEntry,
  confirmPayment,
  getPayment,
  listApprovals,
  listPayments,
  parseSms,
  rejectApproval,
  rejectPayment,
  requestReversal,
  submitPayment,
  type PaymentDeps,
} from '../payments/service';

const idParams = z.object({ id: uuidSchema });

/** Wire fingerprint of a body whose paisa fields have been parsed into bigint. */
const fingerprint = (body: unknown): string =>
  JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** Payments and approvals (spec 5.4, 7). Money moves only in `confirm` and a reversal approval. */
export function paymentRoutes(deps: PaymentDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireWritable, requireStepUp } = guards;
    const cashier = [authenticate, requireRole('cashier')];
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];
    const auditorStepUp = [authenticate, requireRole('auditor'), requireStepUp];

    app.post(
      '/payments',
      { preHandler: [authenticate, requireWritable], schema: { body: paymentSubmitSchema } },
      (req, reply) => {
        const user = requireAuth(req);
        return withIdempotency(deps, req, reply, user.id, fingerprint(req.body), async () => ({
          status: 201,
          body: await submitPayment(deps, user, req.body, { ip: req.ip }),
        }));
      },
    );

    app.get(
      '/payments',
      { preHandler: authenticate, schema: { querystring: paymentsQuerySchema } },
      (req) => listPayments(deps, requireAuth(req), req.query),
    );

    app.post(
      '/payments/cashier-entry',
      { preHandler: cashierStepUp, schema: { body: cashierEntrySchema } },
      (req, reply) => {
        const user = requireAuth(req);
        return withIdempotency(deps, req, reply, user.id, fingerprint(req.body), async () => ({
          status: 201,
          body: await cashierEntry(deps, user, req.body, { ip: req.ip }),
        }));
      },
    );

    app.post(
      '/payments/parse-sms',
      { preHandler: cashier, schema: { body: parseSmsSchema } },
      (req) => parseSms(deps, req.body),
    );

    app.get('/payments/:id', { preHandler: authenticate, schema: { params: idParams } }, (req) =>
      getPayment(deps, requireAuth(req), req.params.id, { ip: req.ip }),
    );

    app.post(
      '/payments/:id/confirm',
      { preHandler: cashierStepUp, schema: { params: idParams, body: paymentConfirmSchema } },
      (req) => confirmPayment(deps, requireAuth(req), req.params.id, req.body, { ip: req.ip }),
    );

    app.post(
      '/payments/:id/reject',
      { preHandler: cashierStepUp, schema: { params: idParams, body: paymentRejectSchema } },
      (req) => rejectPayment(deps, requireAuth(req), req.params.id, req.body, { ip: req.ip }),
    );

    app.post(
      '/payments/:id/reverse-request',
      { preHandler: cashier, schema: { params: idParams, body: reverseRequestSchema } },
      async (req, reply) => {
        const out = await requestReversal(
          deps,
          requireAuth(req),
          req.params.id,
          req.body.reason,
          { ip: req.ip },
        );
        return reply.status(201).send(out);
      },
    );

    app.get(
      '/approvals',
      {
        preHandler: [authenticate, requireRole('cashier', 'auditor')],
        schema: { querystring: approvalsQuerySchema },
      },
      (req) => listApprovals(deps, req.query),
    );

    app.post(
      '/approvals/:id/approve',
      { preHandler: auditorStepUp, schema: { params: idParams, body: approvalDecisionSchema } },
      (req) =>
        approveApproval(deps, requireAuth(req), req.params.id, req.body.note, { ip: req.ip }),
    );

    app.post(
      '/approvals/:id/reject',
      { preHandler: auditorStepUp, schema: { params: idParams, body: approvalDecisionSchema } },
      (req) =>
        rejectApproval(deps, requireAuth(req), req.params.id, req.body.note, { ip: req.ip }),
    );
  };
}
