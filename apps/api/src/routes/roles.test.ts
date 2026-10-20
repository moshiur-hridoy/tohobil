import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund } from '../test/fund-fixture';

/**
 * Table-driven role check over the slice 4 and 5 routes (spec 14.3, Auth): each route is called as
 * every kind of user and must be refused (401 or 403) exactly when the role table says so. Allowed
 * callers may get any other answer (404 for a made-up id, 409, ...): only the guard is under test.
 */
type Who = 'anon' | 'member' | 'readonly' | 'cashier' | 'auditor';
const ALL: Who[] = ['member', 'cashier', 'auditor'];
const ACTIVE: Who[] = ['member', 'cashier', 'auditor'];

const id = randomUUID();
const ROUTES: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown; allowed: Who[] }> = [
  { method: 'POST', url: '/payments', body: { amount_paisa: '100', method: 'cash' }, allowed: ACTIVE },
  { method: 'GET', url: '/payments', allowed: [...ALL, 'readonly'] },
  { method: 'GET', url: `/payments/${id}`, allowed: [...ALL, 'readonly'] },
  { method: 'POST', url: '/payments/cashier-entry', body: { member_id: id, amount_paisa: '100', method: 'cash', paid_at: '2026-01-01T00:00:00Z' }, allowed: ['cashier'] },
  { method: 'POST', url: '/payments/parse-sms', body: { text: 'hello' }, allowed: ['cashier'] },
  { method: 'POST', url: `/payments/${id}/confirm`, body: {}, allowed: ['cashier'] },
  { method: 'POST', url: `/payments/${id}/reject`, body: { reason: 'abc' }, allowed: ['cashier'] },
  { method: 'POST', url: `/payments/${id}/reverse-request`, body: { reason: 'abc' }, allowed: ['cashier'] },
  { method: 'GET', url: '/approvals', allowed: ['cashier', 'auditor'] },
  { method: 'POST', url: `/approvals/${id}/approve`, body: {}, allowed: ['auditor'] },
  { method: 'POST', url: `/approvals/${id}/reject`, body: {}, allowed: ['auditor'] },
  { method: 'POST', url: '/objections', body: { ledger_seq: '1', text: 'abc' }, allowed: ACTIVE },
  { method: 'GET', url: '/objections', allowed: [...ALL, 'readonly'] },
  { method: 'PATCH', url: `/objections/${id}`, body: { status: 'resolved', resolution: 'abc' }, allowed: ['auditor'] },
  { method: 'GET', url: '/matrix', allowed: [...ALL, 'readonly'] },
  { method: 'GET', url: '/settings/payment-instructions', allowed: [...ALL, 'readonly'] },
];

describe('role table for payments, approvals, objections, matrix', () => {
  let db: TestDb | null;
  let app: FastifyInstance;
  let fund: Fund;
  const token: Partial<Record<Who, string>> = {};

  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock: systemClock });
    fund = await seedFund(db.admin);
    const login = async (code: 'M01' | 'M02' | 'M04' | 'M07') => activateSession(app, db!, systemClock, fund, code);
    const stepUp = async (session: { access_token: string }) => {
      const auth = { authorization: `Bearer ${session.access_token}` };
      const enrol = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/enroll', headers: auth });
      const secret = (enrol.json() as { secret: string }).secret;
      await app.inject({ method: 'POST', url: '/api/v1/auth/totp/verify', headers: auth, payload: { code: authenticator.generate(secret) } });
    };
    const [m1, m2, m4, m7] = [await login('M01'), await login('M02'), await login('M04'), await login('M07')];
    await stepUp(m1);
    await stepUp(m7);
    await db.admin.query(`UPDATE members SET status = 'suspended', suspended_on = '2026-09-01' WHERE id = $1`, [fund.members.M04]);
    token.cashier = m1.access_token;
    token.member = m2.access_token;
    token.readonly = m4.access_token;
    token.auditor = m7.access_token;
  });

  afterAll(async () => {
    await db?.close();
  });

  for (const route of ROUTES) {
    it(`${route.method} ${route.url.replace(id, ':id')}`, async (ctx) => {
      if (!db) return ctx.skip();
      for (const who of ['anon', 'member', 'readonly', 'cashier', 'auditor'] as Who[]) {
        const res = await app.inject({
          method: route.method,
          url: `/api/v1${route.url}`,
          headers: token[who] ? { authorization: `Bearer ${token[who]}` } : {},
          ...(route.body === undefined ? {} : { payload: route.body as Record<string, unknown> }),
        });
        const refused = res.statusCode === 401 || res.statusCode === 403;
        const allowed = route.allowed.includes(who);
        expect(refused, `${who} -> ${res.statusCode} ${res.body.slice(0, 120)}`).toBe(!allowed);
        if (who === 'anon') expect(res.statusCode).toBe(401);
      }
    });
  }
});
