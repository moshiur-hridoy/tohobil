import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assetCompleteSchema,
  assetCreateSchema,
  assetListQuerySchema,
  assetPaymentSchema,
  assetUpdateSchema,
  documentAttachSchema,
  uuidSchema,
} from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { notFound } from '../lib/errors';
import type { AuthUser } from '../auth/service';
import {
  attachDocument,
  completeAcquisition,
  createAsset,
  getAsset,
  listAssets,
  listDocuments,
  listValuations,
  payAssetInstalment,
  updateAsset,
  type AssetDeps,
  type AssetActor,
} from '../assets/service';

const idParams = z.object({ id: uuidSchema });

function actorFrom(user: AuthUser, req: FastifyRequest): AssetActor {
  return { userId: user.id, ip: req.ip, deviceId: user.device_id };
}

export function assetRoutes(deps: AssetDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireRole, requireStepUp } = guards;
    const cashier = [authenticate, requireRole('cashier')];
    const cashierStepUp = [authenticate, requireRole('cashier'), requireStepUp];

    app.get(
      '/assets',
      { preHandler: authenticate, schema: { querystring: assetListQuerySchema } },
      async (req) => {
        const q = req.query;
        return listAssets(deps.pool, {
          status: q.status,
          kind: q.kind,
          limit: q.limit ?? 50,
          cursor: q.cursor,
        });
      },
    );

    app.post('/assets', { preHandler: cashier, schema: { body: assetCreateSchema } }, async (req) => {
      const user = requireAuth(req);
      const id = await createAsset(deps, actorFrom(user, req), req.body);
      const asset = await getAsset(deps.pool, id);
      if (!asset) throw notFound('asset.not_found', 'Asset not found');
      return asset;
    });

    app.get('/assets/:id', { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const asset = await getAsset(deps.pool, req.params.id);
      if (!asset) throw notFound('asset.not_found', 'Asset not found');
      return asset;
    });

    app.patch('/assets/:id', { preHandler: cashier, schema: { params: idParams, body: assetUpdateSchema } }, async (req) => {
      const user = requireAuth(req);
      await updateAsset(deps, actorFrom(user, req), req.params.id, req.body);
      const asset = await getAsset(deps.pool, req.params.id);
      if (!asset) throw notFound('asset.not_found', 'Asset not found');
      return asset;
    });

    app.post(
      '/assets/:id/payments',
      { preHandler: cashierStepUp, schema: { params: idParams, body: assetPaymentSchema } },
      async (req) => payAssetInstalment(deps, actorFrom(requireAuth(req), req), req.params.id, req.body),
    );

    app.post(
      '/assets/:id/complete',
      { preHandler: cashierStepUp, schema: { params: idParams, body: assetCompleteSchema } },
      async (req) => {
        await completeAcquisition(deps, actorFrom(requireAuth(req), req), req.params.id, req.body);
        const asset = await getAsset(deps.pool, req.params.id);
        if (!asset) throw notFound('asset.not_found', 'Asset not found');
        return asset;
      },
    );

    app.get('/assets/:id/valuations', { preHandler: authenticate, schema: { params: idParams } }, async (req) =>
      listValuations(deps.pool, req.params.id),
    );

    app.post(
      '/assets/:id/documents',
      { preHandler: cashier, schema: { params: idParams, body: documentAttachSchema } },
      async (req, reply) => {
        const user = requireAuth(req);
        await attachDocument(deps, actorFrom(user, req), req.params.id, req.body);
        return reply.status(204).send();
      },
    );

    app.get('/assets/:id/documents', { preHandler: authenticate, schema: { params: idParams } }, async (req) =>
      listDocuments(deps.pool, req.params.id),
    );
  };
}
