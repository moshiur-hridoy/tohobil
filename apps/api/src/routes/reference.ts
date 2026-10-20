import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type pg from 'pg';
import { duesQuerySchema, finesQuerySchema, rulesQuerySchema, type Clock } from '@barakah/shared';
import { listAccountBalances } from '../accounts/service';
import type { Guards } from '../auth/guards';
import { listDues, listFines } from '../dues/queries';
import { listRuleHistory, listRulesInForce } from '../lib/rules';

export interface ReferenceDeps {
  pool: pg.Pool;
  clock: Clock;
}

/**
 * Read-only reference data every logged-in member can see: rules, account balances, dues and fines
 * (spec 7, roles M). Writes to these tables happen only through proposals and jobs.
 */
export function referenceRoutes(deps: ReferenceDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate } = guards;

    app.get(
      '/rules',
      { preHandler: authenticate, schema: { querystring: rulesQuerySchema } },
      async (req) => {
        const { key, as_of, history } = req.query;
        if (history) return { as_of: null, items: await listRuleHistory(deps.pool, key) };
        const asOf = as_of ?? deps.clock.todayDhaka();
        return { as_of: asOf, items: await listRulesInForce(deps.pool, asOf, key) };
      },
    );

    // How to pay the fund (spec 8, /pay). Read-only here; the cashier edits it with the settings
    // routes in Phase 3. Only the three known keys are returned.
    app.get('/settings/payment-instructions', { preHandler: authenticate }, async () => {
      const res = await deps.pool.query(`SELECT value FROM settings WHERE key = 'payment_instructions'`);
      const value = (res.rows[0] as { value: Record<string, unknown> } | undefined)?.value ?? {};
      const text = (k: string): string => (typeof value[k] === 'string' ? (value[k] as string) : '');
      return { bkash: text('bkash'), nagad: text('nagad'), bank: text('bank') };
    });

    app.get('/accounts/balances', { preHandler: authenticate }, () =>
      listAccountBalances(deps.pool),
    );

    app.get(
      '/dues',
      { preHandler: authenticate, schema: { querystring: duesQuerySchema } },
      (req) => listDues(deps.pool, req.query),
    );

    app.get(
      '/fines',
      { preHandler: authenticate, schema: { querystring: finesQuerySchema } },
      (req) => listFines(deps.pool, req.query),
    );
  };
}
