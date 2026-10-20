import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { type Guards } from '../auth/guards';
import { computeNav, type NavDeps } from '../nav/service';

export function navRoutes(deps: NavDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate } = guards;

    app.get('/nav', { preHandler: authenticate }, async () => {
      const nav = await computeNav(deps);
      return {
        net_assets_paisa: nav.net_assets_paisa.toString(),
        shares_outstanding: nav.shares_outstanding.toString(),
        nav_per_share_paisa: nav.nav_per_share_paisa.toString(),
        cash: nav.cash.map((c) => ({ account: c.account, balance_paisa: c.balance_paisa.toString() })),
        assets: nav.assets.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          valuation_paisa: a.valuation_paisa.toString(),
          value_as_of: a.value_as_of,
        })),
        deductions: nav.deductions.map((d) => ({ account: d.account, balance_paisa: d.balance_paisa.toString() })),
        stale_valuations: nav.stale_valuations,
      };
    });
  };
}
