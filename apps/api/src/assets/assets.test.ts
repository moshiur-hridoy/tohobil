import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

const clock = systemClock;
const todayDhaka = '2026-10-20';

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const cashier = {} as TestSession;
const member = {} as TestSession;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: who ? { authorization: `Bearer ${who}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

const secrets = new Map<string, string>();

async function stepUp(session: TestSession): Promise<void> {
  const res = await call('POST', '/auth/totp/verify', session.access_token, {
    code: authenticator.generate(secrets.get(session.device_id) as string),
  });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

async function enrolStepUp(session: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', session.access_token);
  secrets.set(session.device_id, (enrol.json() as { secret: string }).secret);
  await stepUp(session);
}

describe('assets, rent and NAV', () => {
  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    Object.assign(cashier, await activateSession(app, db, clock, fund, 'M01'));
    Object.assign(member, await activateSession(app, db, clock, fund, 'M02'));
    await enrolStepUp(cashier);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  const assetCreate = async (body: Record<string, unknown>) => {
    const res = await call('POST', '/assets', cashier.access_token, body);
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  dbIt('cashier notes down a planned asset; member can read the list and detail', async () => {
    const asset = await assetCreate({ kind: 'house', name: 'Test House', location: 'Dhaka' });
    expect(asset.kind).toBe('house');
    expect(asset.status).toBe('planned');
    expect(asset.cost_paisa).toBe('0');

    const list = await call('GET', '/assets', member.access_token);
    expect(list.statusCode).toBe(200);
    expect((list.json().items as unknown[]).length).toBeGreaterThanOrEqual(1);

    const detail = await call('GET', `/assets/${asset.id}`, member.access_token);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().name).toBe('Test House');
  });

  dbIt('money, status, sale and valuation cannot be set by hand: only proposals move them', async () => {
    // cost and status are not accepted on create or update (the schema is strict) ...
    expect((await call('POST', '/assets', cashier.access_token, { kind: 'gold', name: 'G', cost_paisa: '5000000', status: 'held' })).statusCode).toBe(400);
    const asset = await assetCreate({ kind: 'gold', name: 'Gold Bar', quantity: '2.5000', unit: 'vori' });
    for (const body of [{ status: 'held' }, { status: 'sold' }, { cost_paisa: '1' }, { sale_price_paisa: '1' }]) {
      expect((await call('PATCH', `/assets/${asset.id}`, cashier.access_token, body)).statusCode).toBe(400);
    }
    // ... and there is no route to write a valuation (valuation_update proposals do that)
    const val = await call('POST', `/assets/${asset.id}/valuations`, cashier.access_token, { value_paisa: '6000000', as_of: todayDhaka });
    expect(val.statusCode).toBe(404);
    // descriptive edits are fine
    const ok = await call('PATCH', `/assets/${asset.id}`, cashier.access_token, { location: 'Locker 4' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().location).toBe('Locker 4');
  });

  dbIt('cashier attaches a document to an asset', async () => {
    const asset = await assetCreate({ kind: 'land', name: 'Agricultural Plot' });
    const file = await db!.admin.query(
      `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by)
       VALUES ($1,'application/pdf',1024,$2,'deed.pdf',$3) RETURNING id`,
      ['a'.repeat(64), `/data/files/${'a'.repeat(64)}.pdf`, fund.users.M01],
    );
    const fileId = (file.rows[0] as { id: string }).id;

    const attach = await call('POST', `/assets/${asset.id}/documents`, cashier.access_token, {
      file_id: fileId,
      doc_type: 'deed',
      title: 'Ownership deed',
    });
    expect(attach.statusCode).toBe(204);

    const docs = await call('GET', `/assets/${asset.id}/documents`, member.access_token);
    expect(docs.statusCode).toBe(200);
    expect((docs.json() as unknown[])[0]).toMatchObject({ doc_type: 'deed', title: 'Ownership deed' });
  });

  dbIt('rent stream generates expected rent and a receipt posts to the ledger', async () => {
    const streamRes = await call('POST', '/rent/streams', cashier.access_token, {
      name: 'Shop 1',
      tenant_name: 'Rahim Traders',
      monthly_amount_paisa: '300000',
      due_day: 5,
      active_from: '2026-10-01',
    });
    expect(streamRes.statusCode).toBe(200);

    const gen = await call('POST', '/rent/expected/generate', cashier.access_token, { period: '2026-10' });
    expect(gen.statusCode).toBe(200);
    expect(gen.json().created).toBe(1);

    const expectedList = await call('GET', '/rent/expected?period=2026-10', cashier.access_token);
    expect(expectedList.statusCode).toBe(200);
    const expected = (expectedList.json().items as Array<Record<string, unknown>>)[0];
    expect(expected).toMatchObject({ amount_paisa: '300000', status: 'expected' });

    const receipt = await call('POST', `/rent/expected/${expected!.id}/receive`, cashier.access_token, {
      amount_paisa: '300000',
      method: 'cash',
      paid_at: todayDhaka,
    });
    expect(receipt.statusCode).toBe(200);
    const receiptBody = receipt.json() as Record<string, unknown>;
    expect(receiptBody.received_paisa).toBe('300000');

    const ledger = await q(
      `SELECT debit_account, credit_account, amount_paisa::text FROM ledger_entries WHERE ref_type='rent_receipt'`,
    );
    expect(ledger[0]).toMatchObject({ debit_account: 'CASH', credit_account: 'RENT_INCOME', amount_paisa: '300000' });
  });

  dbIt('GET /nav reflects cash and held asset valuation', async () => {
    // A held asset can only come from an executed purchase; here the row is planted to test NAV alone.
    await db!.admin.query(
      `INSERT INTO assets (kind, name, cost_paisa, status) VALUES ('house', 'NAV House', 100000000, 'held')`,
    );

    const navRes = await call('GET', '/nav', member.access_token);
    expect(navRes.statusCode).toBe(200);
    const nav = navRes.json() as Record<string, unknown>;
    expect(nav.net_assets_paisa).toBeDefined();
    expect(nav.shares_outstanding).toBe('20');
    expect(nav.nav_per_share_paisa).toBeDefined();

    const cash = nav.cash as Array<{ account: string; balance_paisa: string }>;
    expect(cash.find((c) => c.account === 'CASH')?.balance_paisa).toBe('300000');

    const assets = nav.assets as Array<{ name: string; valuation_paisa: string }>;
    expect(assets.some((a) => a.name === 'NAV House' && a.valuation_paisa === '100000000')).toBe(true);
  });
  dbIt('a partner page lists every purchase with its ledger entry, papers, terms and valuations', async () => {
    const created = await call('POST', '/partners', cashier.access_token, { kind: 'gold', name: 'Minar Jewellers', rate_percent: 2.5, period_months: 3, sharing_policy: 'By shares' });
    expect(created.statusCode).toBe(200);
    const partnerId = (created.json().partner as { id: string }).id;
    expect((await call('POST', '/partners', cashier.access_token, { kind: 'gold', name: 'minar jewellers' })).statusCode).toBe(409);

    const a = await db!.admin.query(
      `INSERT INTO assets (kind, name, cost_paisa, status, acquired_on) VALUES ('gold', 'Gold', 0, 'acquiring', '2026-09-01') RETURNING id`,
    );
    const assetId = (a.rows[0] as { id: string }).id;
    const pay = await call('POST', `/assets/${assetId}/payments`, cashier.access_token, { amount_paisa: '2500000', account: 'BANK', note: 'Cheque 0042 to the shop' });
    expect(pay.statusCode).toBe(200);
    await db!.admin.query(`INSERT INTO asset_valuations (asset_id, value_paisa, as_of) VALUES ($1, 2600000, '2026-10-01')`, [assetId]);

    // not on the page until the partner adopts it
    expect((await call('GET', `/partners/${partnerId}`, member.access_token)).json().assets).toHaveLength(0);
    const adopt = await call('POST', `/partners/${partnerId}/adopt`, cashier.access_token);
    expect(adopt.json().adopted).toBeGreaterThanOrEqual(1);

    const file = await db!.admin.query(
      `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by)
       VALUES ($1,'application/pdf',1024,$2,'contract.pdf',$3) RETURNING id`,
      ['b'.repeat(64), `/data/files/${'b'.repeat(64)}.pdf`, fund.users.M01],
    );
    const fileId = (file.rows[0] as { id: string }).id;
    expect((await call('POST', `/partners/${partnerId}/documents`, cashier.access_token, { file_id: fileId, doc_type: 'contract' })).statusCode).toBe(204);

    const patched = await call('PATCH', `/partners/${partnerId}`, cashier.access_token, { name: 'Minar Jewellers Ltd', rate_percent: 3 });
    expect(patched.statusCode).toBe(200);

    const res = await call('GET', `/partners/${partnerId}`, member.access_token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { partner: Record<string, unknown>; assets: Array<{ id: string }>; entries: Array<Record<string, unknown>>; valuations: Array<Record<string, unknown>>; documents: Array<Record<string, unknown>> };
    expect(body.partner).toMatchObject({ name: 'Minar Jewellers Ltd', rate_percent: 3, period_months: 3, sharing_policy: 'By shares' });
    expect(body.assets.some((x) => x.id === assetId)).toBe(true);
    expect(body.entries.find((e) => e.asset_id === assetId)).toMatchObject({ amount_paisa: '2500000', account: 'BANK', memo: 'Cheque 0042 to the shop', reversed: false });
    expect(body.valuations.find((v) => v.asset_id === assetId)).toMatchObject({ value_paisa: '2600000', as_of: '2026-10-01' });
    expect(body.documents.find((d) => d.entity_type === 'partner')).toMatchObject({ doc_type: 'contract' });
    expect((await call('PATCH', `/partners/${partnerId}`, member.access_token, { name: 'x' })).statusCode).toBe(403);
  });
});
