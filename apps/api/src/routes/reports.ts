import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { reportExportQuerySchema, reportStatementQuerySchema, reportZakatQuerySchema, yearSchema } from '@barakah/shared';
import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import { requireAuth, type Guards } from '../auth/guards';
import { audit } from '../lib/audit';
import { forbidden } from '../lib/errors';
import { archiveExists, streamArchiveZip } from '../reports/annual';
import { buildCsv } from '../reports/csv';
import { memberStatementPdf, zakatStatementPdf } from '../reports/documents';
import { notFound } from '../lib/errors';

export interface ReportDeps {
  pool: pg.Pool;
  clock: Clock;
  archivesDir: string;
}

/** A member sees their own statements; the cashier and auditor see anyone's. */
function memberFor(req: FastifyRequest, requested?: string): string {
  const user = requireAuth(req);
  const privileged = user.roles.includes('cashier') || user.roles.includes('auditor');
  if (requested && requested !== user.member_id && !privileged) throw forbidden();
  return requested ?? user.member_id;
}

function send(reply: FastifyReply, type: string, filename: string, body: Buffer | string): FastifyReply {
  return reply
    .header('content-type', type)
    .header('content-disposition', `attachment; filename="${filename}"`)
    .header('cache-control', 'no-store')
    .send(body);
}

/** Statements, exports and the annual archive. Every download is written to the audit log (spec 19.4). */
export function reportRoutes(deps: ReportDeps, guards: Guards) {
  return async function register(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const { authenticate } = guards;
    const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

    app.get('/reports/statement', { preHandler: authenticate, config: limit, schema: { querystring: reportStatementQuerySchema } }, async (req, reply) => {
      const memberId = memberFor(req, req.query.member_id);
      const pdf = await memberStatementPdf(deps.pool, deps.clock, memberId, req.query.period);
      await audit(deps.pool, { actor: requireAuth(req).id, action: 'report.statement', entityType: 'member', entityId: memberId, after: { period: req.query.period }, ip: req.ip, deviceId: requireAuth(req).device_id });
      return send(reply, 'application/pdf', `statement-${req.query.period}.pdf`, pdf);
    });

    app.get('/reports/zakat-statement', { preHandler: authenticate, config: limit, schema: { querystring: reportZakatQuerySchema } }, async (req, reply) => {
      const memberId = memberFor(req, req.query.member_id);
      const pdf = await zakatStatementPdf(deps.pool, deps.clock, memberId, req.query.as_of);
      await audit(deps.pool, { actor: requireAuth(req).id, action: 'report.zakat', entityType: 'member', entityId: memberId, after: { as_of: req.query.as_of ?? null }, ip: req.ip, deviceId: requireAuth(req).device_id });
      return send(reply, 'application/pdf', 'zakat-statement.pdf', pdf);
    });

    app.get('/reports/export.csv', { preHandler: authenticate, config: limit, schema: { querystring: reportExportQuerySchema } }, async (req, reply) => {
      const { entity, from, to } = req.query;
      const { csv, rows } = await buildCsv(deps.pool, entity, { from, to });
      await audit(deps.pool, { actor: requireAuth(req).id, action: 'report.export', entityType: 'export', entityId: entity, after: { rows, from: from ?? null, to: to ?? null }, ip: req.ip, deviceId: requireAuth(req).device_id });
      return send(reply, 'text/csv; charset=utf-8', `${entity}.csv`, csv);
    });

    app.get('/reports/annual', { preHandler: authenticate, config: limit, schema: { querystring: z.object({ year: yearSchema }) } }, async (req, reply) => {
      const { year } = req.query;
      if (!(await archiveExists(deps, year))) throw notFound('archive.not_found', `No archive has been created for ${year}`);
      await audit(deps.pool, { actor: requireAuth(req).id, action: 'report.annual', entityType: 'year', entityId: year, ip: req.ip, deviceId: requireAuth(req).device_id });
      const out = new PassThrough();
      reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="barakah-${year}.zip"`).header('cache-control', 'no-store');
      void streamArchiveZip(deps, year, out).catch((err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))));
      return reply.send(out);
    });
  };
}
