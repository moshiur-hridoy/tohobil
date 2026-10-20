import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateAndLogin, seedFund, testEnv, type Fund } from '../test/fund-fixture';

const clock = createFakeClock(new Date('2026-11-05T03:00:00Z'));

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
let token: string;

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  token = await activateAndLogin(app, db, clock, fund, 'M02');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('GET /api/v1/openapi.json', () => {
  it('is for signed-in users only', async (ctx) => {
    if (!db) return ctx.skip();
    expect((await app.inject('/api/v1/openapi.json')).statusCode).toBe(401);
  });

  it('describes the API from the schemas that validate it', async (ctx) => {
    if (!db) return ctx.skip();
    const res = await app.inject({ url: '/api/v1/openapi.json', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; info: { title: string }; paths: Record<string, Record<string, { requestBody?: unknown }>> };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('Barakah Fund API');

    const paths = Object.keys(doc.paths);
    // a sample from every area, including the Phase 4 and 5 routes
    for (const p of [
      '/api/v1/auth/login',
      '/api/v1/auth/pin/change',
      '/api/v1/members/{id}/pin',
      '/api/v1/ledger',
      '/api/v1/payments',
      '/api/v1/proposals',
      '/api/v1/assets/{id}/payments',
      '/api/v1/levy/remittances',
      '/api/v1/financing',
      '/api/v1/reconciliations',
      '/api/v1/periods/{period}/lock',
      '/api/v1/reports/statement',
      '/api/v1/system/status',
    ]) {
      expect(paths, p).toContain(p);
    }
    // the request body of a route is the zod schema, so a required field is listed as required
    expect(doc.paths['/api/v1/auth/login']!.post!.requestBody).toBeDefined();
    expect(JSON.stringify(doc.paths['/api/v1/auth/login'])).toContain('member_ref');
    // the document itself is not listed in itself
    expect(paths).not.toContain('/api/v1/openapi.json');
  });
});
