import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

const clock = systemClock;

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M07', TestSession>;
const secrets = new Map<string, string>();

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: who ? { authorization: `Bearer ${who}` } : undefined,
    payload,
  });

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

async function enrolStepUp(session: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', session.access_token);
  secrets.set(session.device_id, (enrol.json() as { secret: string }).secret);
  const res = await call('POST', '/auth/totp/verify', session.access_token, {
    code: authenticator.generate(secrets.get(session.device_id) as string),
  });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  for (const code of ['M01', 'M02', 'M07'] as const) {
    s[code] = await activateSession(app, db, clock, fund, code);
  }
  await enrolStepUp(s.M01);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn();
  });
}

describe('settings routes', () => {
  dbIt('GET /settings returns whitelisted public values', async () => {
    const res = await call('GET', '/settings', s.M02.access_token);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { fund_name: unknown; payment_instructions: unknown };
    expect(json.fund_name).toBe('বারাকাহ ফান্ড');
    expect(json.payment_instructions).toMatchObject({ bkash: expect.any(String) });
  });

  dbIt('rejects anonymous read', async () => {
    const res = await call('GET', '/settings');
    expect(res.statusCode).toBe(401);
  });

  dbIt('cashier can update payment instructions with step-up', async () => {
    const body = {
      key: 'payment_instructions',
      value: { bkash: '+8801711111111', nagad: '+8801722222222', bank: 'New Bank, A/C: 12345' },
    };
    const res = await call('PATCH', '/settings', s.M01.access_token, body);
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.key).toBe('payment_instructions');
    expect(json.value).toEqual(body.value);

    const row = await q(`SELECT value FROM settings WHERE key = 'payment_instructions'`);
    expect(row[0].value).toEqual(body.value);

    const auditRows = await q(`SELECT action, entity_type, entity_id, before, after FROM audit_log WHERE action='settings.update' ORDER BY id DESC LIMIT 1`);
    expect(auditRows[0]).toMatchObject({ action: 'settings.update', entity_type: 'settings', entity_id: 'payment_instructions', after: body.value });
  });

  dbIt('member without cashier role cannot update settings', async () => {
    const res = await call('PATCH', '/settings', s.M02.access_token, {
      key: 'fund_name',
      value: 'Hacked Fund',
    });
    expect(res.statusCode).toBe(403);
  });

  dbIt('auditor cannot update settings', async () => {
    await enrolStepUp(s.M07);
    const res = await call('PATCH', '/settings', s.M07.access_token, {
      key: 'fund_name',
      value: 'Auditor Fund',
    });
    expect(res.statusCode).toBe(403);
  });

  dbIt('rejects unknown setting key', async () => {
    const res = await call('PATCH', '/settings', s.M01.access_token, {
      key: 'hacker',
      value: 'bad',
    });
    expect(res.statusCode).toBe(400);
  });

  dbIt('validates payment instruction shape', async () => {
    const res = await call('PATCH', '/settings', s.M01.access_token, {
      key: 'payment_instructions',
      value: { bkash: '+88017' },
    });
    expect(res.statusCode).toBe(400);
  });
});
