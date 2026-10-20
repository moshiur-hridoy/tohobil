import { createHash } from 'node:crypto';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FILE_MAX_BYTES, fileViewQuerySchema, uuidSchema } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import {
  contentDisposition,
  openFile,
  tooLarge,
  uploadFile,
  type FileDeps,
} from '../files/service';
import { badRequest } from '../lib/errors';
import { withIdempotency } from '../lib/idempotency';

const idParams = z.object({ id: uuidSchema });

/** `POST /files` (role A) and `GET /files/:id` (role M). See `files/service.ts` for the rules. */
export function fileRoutes(deps: FileDeps & { uploadsPerMinute: number }, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    await instance.register(multipart, {
      // One file per request. The cap stops reading the upload, so an oversized file never fills memory.
      limits: { fileSize: FILE_MAX_BYTES, files: 1, fields: 4, parts: 5 },
    });
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate, requireWritable } = guards;

    app.post(
      '/files',
      {
        preHandler: [authenticate, requireWritable],
        config: { rateLimit: { max: deps.uploadsPerMinute, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const user = requireAuth(req);
        if (!req.isMultipart()) {
          throw badRequest('file.not_multipart', 'Send the file as multipart/form-data');
        }
        const part = await req.file();
        if (!part) throw badRequest('file.missing_part', 'No file was sent');

        let bytes: Buffer;
        try {
          bytes = await part.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
          throw err;
        }
        if (part.file.truncated) throw tooLarge();

        // A retried upload is "the same request" when the bytes and the name match.
        const fingerprint = `${createHash('sha256').update(bytes).digest('hex')}|${part.filename}`;
        return withIdempotency(deps, req, reply, user.id, fingerprint, async () => ({
          status: 201,
          body: await uploadFile(
            deps,
            user,
            { bytes, originalName: part.filename },
            { ip: req.ip },
          ),
        }));
      },
    );

    app.get(
      '/files/:id',
      {
        preHandler: authenticate,
        schema: { params: idParams, querystring: fileViewQuerySchema },
      },
      async (req, reply) => {
        const view = await openFile(
          deps,
          requireAuth(req),
          req.params.id,
          { thumb: req.query.thumb === true },
          { ip: req.ip },
        );
        return reply
          .header('content-type', view.contentType)
          .header('content-length', view.size)
          .header('content-disposition', contentDisposition(view.disposition, view.filename))
          .header('x-content-type-options', 'nosniff')
          .send(view.stream);
      },
    );
  };
}
