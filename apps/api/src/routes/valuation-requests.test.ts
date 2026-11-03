import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import { valuationRoute } from '../assets/valuation-requests';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

// The real clock: TOTP codes made here are checked against the app's clock.
const clock = systemClock;

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M03' | 'M07', TestSession>;
let partnerId: string;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: who ? { authorization: `Bearer ${who}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

const secrets = new Map<string, string>();
async function enrolStepUp(session: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', session.access_token);
  secrets.set(session.device_id, (enrol.json() as { secret: string }).secret);
  const res = await call('POST', '/auth/totp/verify', session.access_token, { code: authenticator.generate(secrets.get(session.device_id) as string) });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

let fileN = 0;
async function statement(userId: string): Promise<string> {
  const sha = String(++fileN).padStart(64, '0');
  const rows = await q(
    `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by) VALUES ($1, 'image/png', 10, $2, 'statement.png', $3) RETURNING id`,
    [sha, `/data/files/${sha}.png`, userId],
  );
  return (rows[0] as { id: string }).id;
}

const value = async () => BigInt((await call('GET', `/partners/${partnerId}`, s.M02.access_token)).json().assets.reduce((t: bigint, a: { latest_value_paisa: string | null; cost_paisa: string }) => t + BigInt(a.latest_value_paisa ?? a.cost_paisa), 0n));
const send = async (who: TestSession, newValue: bigint, userId: string) =>
  call('POST', `/partners/${partnerId}/valuation-requests`, who.access_token, {
    new_value_paisa: newValue.toString(),
    as_of: '2026-10-31',
    note: 'Minar statement, 31 Oct',
    proof_file_id: await statement(userId),
  });

describe('value updates of an investment (ASSUMPTIONS 115)', () => {
  beforeAll(async () => {
    db = await createTestDb({ cashByMethod: true });
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    for (const code of ['M01', 'M02', 'M03', 'M07'] as const) Object.assign((s[code] = {} as TestSession), await activateSession(app, db, clock, fund, code));
    await enrolStepUp(s.M07);
    const created = await call('POST', '/partners', s.M01.access_token, { kind: 'gold', name: 'Minar Jewellers' });
    partnerId = created.json().partner.id as string;
    // Two purchases: 6,00,000 and 4,00,000 taka at cost, so the shop is worth 10,00,000 until valued.
    await q(
      `INSERT INTO assets (kind, name, cost_paisa, status, acquired_on, partner_id) VALUES
         ('gold', 'Gold 1', 60000000, 'held', '2026-01-10', $1), ('gold', 'Gold 2', 40000000, 'held', '2026-03-10', $1)`,
      [partnerId],
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  it('decides the route: a rise up to 10% for the auditor, anything else to a vote', () => {
    const r = (base: bigint, next: bigint, concernsAuditor = false, hasAuditor = true) => valuationRoute({ base, next, concernsAuditor, hasAuditor });
    expect(r(1000n, 1100n)).toBe('auditor');
    expect(r(1000n, 1000n)).toBe('auditor');
    expect(r(1000n, 1101n)).toBe('vote');
    expect(r(1000n, 999n)).toBe('vote');
    expect(r(1000n, 1050n, true)).toBe('vote');
    expect(r(1000n, 1050n, false, false)).toBe('vote');
  });

  dbIt('only the cashier sets who looks after the shop; that member is told and shown to everyone', async () => {
    expect((await call('PATCH', `/partners/${partnerId}`, s.M02.access_token, { custodian_member_id: fund.members.M02 })).statusCode).toBe(403);
    const res = await call('PATCH', `/partners/${partnerId}`, s.M01.access_token, { custodian_member_id: fund.members.M02 });
    expect(res.statusCode, res.body).toBe(200);
    const seen = (await call('GET', `/partners/${partnerId}`, s.M03.access_token)).json().partner;
    expect(seen).toMatchObject({ custodian_code: 'M02' });
    expect(await q(`SELECT 1 FROM notifications WHERE member_id = $1 AND template = 'custodian_assigned'`, [fund.members.M02])).toHaveLength(1);
  });

  dbIt('another member cannot send a value; the responsible member can, and a rise waits for the auditor', async () => {
    expect((await send(s.M03, 105_000_000n, fund.users.M03)).statusCode).toBe(403);
    const before = await value();
    const res = await send(s.M02, 105_000_000n, fund.users.M02); // +5%
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ route: 'auditor', proposal_id: null });
    expect(await value()).toBe(before); // nothing moves before approval
    expect(await q(`SELECT 1 FROM notifications WHERE member_id = $1 AND template = 'valuation_review'`, [fund.members.M07])).toHaveLength(1);
    // one update per shop at a time
    expect((await send(s.M02, 104_000_000n, fund.users.M02)).statusCode).toBe(409);

    const list = (await call('GET', '/approvals?status=pending&kind=valuation_update', s.M07.access_token)).json().items as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ partner_name: 'Minar Jewellers', base_value_paisa: '100000000', new_value_paisa: '105000000' });

    const ok = await call('POST', `/approvals/${res.json().approval_id}/approve`, s.M07.access_token, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await value()).toBe(105_000_000n);
    // split by cost, 60/40, with the approval recorded on each valuation
    const vals = await q(`SELECT value_paisa::text AS v FROM asset_valuations WHERE approval_id = $1 ORDER BY value_paisa DESC`, [res.json().approval_id]);
    expect(vals.map((v) => (v as { v: string }).v)).toEqual(['63000000', '42000000']);
    expect(await q(`SELECT 1 FROM notifications WHERE template = 'valuation_updated'`)).not.toHaveLength(0);
    const history = (await call('GET', `/partners/${partnerId}`, s.M03.access_token)).json().valuation_requests as Array<Record<string, unknown>>;
    expect(history[0]).toMatchObject({ status: 'approved', route: 'auditor', requested_by_code: 'M02', decided_by_code: 'M07' });
  });

  dbIt('a fall opens a vote for three days and changes nothing until it is carried out', async () => {
    const before = await value();
    const res = await send(s.M02, before - 2_000_000n, fund.users.M02);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ route: 'vote', approval_id: null });
    const p = (await q(`SELECT status, type, round(EXTRACT(EPOCH FROM closes_at - opens_at) / 3600)::int AS hours FROM proposals WHERE id = $1`, [res.json().proposal_id]))[0] as { status: string; type: string; hours: number };
    expect(p).toMatchObject({ status: 'open', type: 'valuation_update', hours: 72 });
    expect(await value()).toBe(before);
    // cancel it so the next test can send again
    expect((await call('POST', `/proposals/${res.json().proposal_id}/cancel`, s.M01.access_token, { reason: 'test cleanup' })).statusCode).toBe(200);
  });

  dbIt('a rise of more than 10% goes to a vote, and so does one that concerns the auditor', async () => {
    const big = await send(s.M02, (await value()) * 2n, fund.users.M02);
    expect(big.json()).toMatchObject({ route: 'vote' });
    await call('POST', `/proposals/${big.json().proposal_id}/cancel`, s.M01.access_token, { reason: 'test cleanup' });

    await call('PATCH', `/partners/${partnerId}`, s.M01.access_token, { custodian_member_id: fund.members.M07 });
    const byAuditor = await send(s.M07, (await value()) + 100n, fund.users.M07);
    expect(byAuditor.json()).toMatchObject({ route: 'vote' });
    await call('POST', `/proposals/${byAuditor.json().proposal_id}/cancel`, s.M01.access_token, { reason: 'test cleanup' });
    await call('PATCH', `/partners/${partnerId}`, s.M01.access_token, { custodian_member_id: fund.members.M02 });
  });

  dbIt('the auditor must give a reason to decline, the sender reads it, and a stale update cannot be approved', async () => {
    const first = await send(s.M02, (await value()) + 1_000n, fund.users.M02);
    const id = first.json().approval_id as string;
    expect((await call('POST', `/approvals/${id}/reject`, s.M07.access_token, {})).statusCode).toBe(400);
    expect((await call('POST', `/approvals/${id}/reject`, s.M07.access_token, { note: 'statement date is wrong' })).statusCode).toBe(200);
    expect(await q(`SELECT 1 FROM notifications WHERE member_id = $1 AND template = 'valuation_rejected'`, [fund.members.M02])).toHaveLength(1);
    const history = (await call('GET', `/partners/${partnerId}`, s.M02.access_token)).json().valuation_requests as Array<Record<string, unknown>>;
    expect(history[0]).toMatchObject({ status: 'rejected', decision_note: 'statement date is wrong' });

    const second = await send(s.M02, (await value()) + 1_000n, fund.users.M02);
    // the shop's value changes before the auditor looks (here: a valuation added directly)
    await q(`INSERT INTO asset_valuations (asset_id, value_paisa, as_of) SELECT id, cost_paisa, '2026-11-01' FROM assets WHERE partner_id = $1`, [partnerId]);
    const stale = await call('POST', `/approvals/${second.json().approval_id}/approve`, s.M07.access_token, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('valuation.base_changed');
  });

  dbIt('the cashier can send for the member, and the statement must be a real upload', async () => {
    const bad = await call('POST', `/partners/${partnerId}/valuation-requests`, s.M01.access_token, {
      new_value_paisa: '1', as_of: '2026-10-31', proof_file_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(bad.statusCode).toBe(400);
    expect((await call('POST', `/partners/${partnerId}/valuation-requests`, s.M01.access_token, {
      new_value_paisa: '1', as_of: '2999-01-01', proof_file_id: await statement(fund.users.M01),
    })).json().code).toBe('valuation.future_date');
  });
});
