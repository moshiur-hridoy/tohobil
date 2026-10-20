import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { matrixQuerySchema } from '@barakah/shared';
import type { Guards } from '../auth/guards';
import { getMatrix, type MatrixDeps } from '../matrix/service';

/** `GET /matrix` (role M): the member x period grid of the legacy sheet. */
export function matrixRoutes(deps: MatrixDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    app.get(
      '/matrix',
      { preHandler: guards.authenticate, schema: { querystring: matrixQuerySchema } },
      (req) => getMatrix(deps, req.query),
    );
  };
}
