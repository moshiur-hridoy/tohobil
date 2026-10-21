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
const token = {} as Record<'M01' | 'M02' | 'M03', string>;

const get = (url: string, who: string) =>
  app.inject({ url: `/api/v1${url}`, headers: { authorization: `Bearer ${who}` } });

async function addSettlement(memberId: string): Promise<string> {
  const snap = await db!.admin.query(
    `INSERT INTO member_snapshots
       (member_id, kind, taken_on, shares, net_assets_paisa, shares_outstanding, nav_per_share_paisa,
        paid_in_capital_paisa, gross_paisa, escrow_paisa, deductions, net_paisa)
     VALUES ($1,'settlement_quote','2026-11-05',4,8000000,20,400000,8000000,8000000,0,
             '{"principal_paisa":"0","fines_paisa":"200000","exit_fee_paisa":"800000","total_paisa":"1000000"}',7000000)
     RETURNING id`,
    [memberId],
  );
  const res = await db!.admin.query(
    `INSERT INTO settlements (member_id, snapshot_id, proposal_id, kind, net_paisa, payout_plan)
     VALUES ($1,$2,gen_random_uuid(),'early_exit',7000000,
             '[{"due_on":"2027-02-15","amount_paisa":"3000000"},{"due_on":"2027-03-15","amount_paisa":"4000000"}]')
     RETURNING id`,
    [memberId, (snap.rows[0] as { id: string }).id],
  );
  return (res.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  for (const code of ['M01', 'M02', 'M03'] as const) {
    token[code] = await activateAndLogin(app, db, clock, fund, code);
  }
  await addSettlement(fund.members.M02);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('GET /settlements', () => {
  it('shows a member their own settlement with the voted numbers and the payout plan', async (ctx) => {
    if (!db) return ctx.skip();
    const res = await get('/settlements', token.M02);
    expect(res.statusCode).toBe(200);
    const [s] = res.json().items;
    expect(res.json().items).toHaveLength(1);
    expect(s).toMatchObject({
      kind: 'early_exit',
      status: 'approved',
      gross_paisa: '8000000',
      fines_paisa: '200000',
      exit_fee_paisa: '800000',
      net_paisa: '7000000',
    });
    expect(s.payouts).toEqual([
      { id: null, due_on: '2027-02-15', amount_paisa: '3000000', paid_at: null },
      { id: null, due_on: '2027-03-15', amount_paisa: '4000000', paid_at: null },
    ]);
  });

  it("does not show another member's settlement", async (ctx) => {
    if (!db) return ctx.skip();
    expect((await get('/settlements', token.M03)).json().items).toEqual([]);
    // asking for someone else's by id does not widen what a regular member sees
    const res = await get(`/settlements?member_id=${fund.members.M02}`, token.M03);
    expect(res.json().items).toEqual([]);
  });

  it('shows every settlement to the cashier', async (ctx) => {
    if (!db) return ctx.skip();
    const res = await get('/settlements', token.M01);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].member_code).toBe('M02');
  });
});
