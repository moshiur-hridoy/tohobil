import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { AUDITOR_PIN, activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

// ASSUMPTIONS 132: with one cash pool the month-end check is one bank figure plus each shop's statement.
const clock = createFakeClock(new Date('2027-01-05T04:00:00Z')); // 5 Jan 2027, 10:00 in Dhaka

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const cashier = {} as TestSession;
const auditor = {} as TestSession;
let shopId: string;

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;
const call = (method: 'GET' | 'POST', url: string, who: TestSession, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${who.access_token}`, ...(who === auditor ? AUDITOR_PIN : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  Object.assign(cashier, await activateSession(app, db, clock, fund, 'M01'));
  Object.assign(auditor, await activateSession(app, db, clock, fund, 'M07'));
  const enrol = await call('POST', '/auth/totp/enroll', cashier);
  const code = authenticator.clone({ epoch: clock.now().getTime() }).generate((enrol.json() as { secret: string }).secret);
  if ((await call('POST', '/auth/totp/verify', cashier, { code })).statusCode !== 200) throw new Error('step-up failed');

  shopId = ((await q(`INSERT INTO investment_partners (kind, name) VALUES ('gold', 'Minar Jewellers') RETURNING id`))[0] as { id: string }).id;
  const asset = ((await q(
    `INSERT INTO assets (kind, name, cost_paisa, status, acquired_on, partner_id) VALUES ('gold', 'Gold Dec', 300000, 'held', '2026-12-15', $1) RETURNING id`,
    [shopId],
  ))[0] as { id: string }).id;
  // December: 20,000 into the bank, 5,000 cash (an old separate account, part of the pool), 3,000 to the shop.
  await q(
    `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id, memo) VALUES
       ('2026-12-10', 'BANK', 'MEMBER_CAPITAL', 2000000, $1, 'import', NULL, 'dues'),
       ('2026-12-12', 'CASH', 'MEMBER_CAPITAL', 500000, $1, 'import', NULL, 'cash dues'),
       ('2026-12-15', 'INVESTMENTS_AT_COST', 'BANK', 300000, NULL, 'import', $2, 'gold')`,
    [fund.members.M02, asset],
  );
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

describe('month-end check with one cash pool and shops (ASSUMPTIONS 132)', () => {
  dbIt('asks for one bank figure for the whole pool and each shop money went to, with the month in and out', async () => {
    const month = (await call('GET', '/reconciliations?period=2026-12', cashier)).json();
    expect(month.mode).toBe('pool');
    expect(month.accounts).toEqual([expect.objectContaining({ account: 'BANK', books_paisa: '2200000', submitted: null })]);
    expect(month.shops).toEqual([expect.objectContaining({ partner_id: shopId, name: 'Minar Jewellers', sent_paisa: '300000', purchases: 1 })]);
    expect(month.summary).toEqual({
      opening_paisa: '0',
      closing_paisa: '2200000',
      lines: [
        { key: 'deposits', amount_paisa: '2500000' },
        { key: 'investments', amount_paisa: '-300000' },
      ],
    });
  });

  dbIt('refuses rows the month does not need, or a missing shop', async () => {
    const four = ['CASH', 'BANK', 'BKASH', 'NAGAD'].map((account) => ({ account, actual_balance_paisa: '0' }));
    expect((await call('POST', '/reconciliations', cashier, { period: '2026-12', entries: four })).json().code).toBe('reconciliation.wrong_accounts');
    const noShop = await call('POST', '/reconciliations', cashier, { period: '2026-12', entries: [{ account: 'BANK', actual_balance_paisa: '2200000' }] });
    expect(noShop.json().code).toBe('reconciliation.wrong_shops');
  });

  dbIt('a shop statement that differs needs a note', async () => {
    const body = (note?: string) => ({
      period: '2026-12',
      entries: [{ account: 'BANK', actual_balance_paisa: '2200000' }],
      shops: [{ partner_id: shopId, statement_paisa: '290000', ...(note ? { note } : {}) }],
    });
    expect((await call('POST', '/reconciliations', cashier, body())).json().code).toBe('reconciliation.note_required');
    expect((await call('POST', '/reconciliations', cashier, body('Shop lists 100 taka as making charge'))).statusCode).toBe(200);
    const month = (await call('GET', '/reconciliations?period=2026-12', cashier)).json();
    expect(month.counted).toBe(true);
    expect(month.shops[0].submitted).toMatchObject({ difference_paisa: '-10000', note: 'Shop lists 100 taka as making charge' });
  });

  dbIt('the auditor cannot approve a count the books have moved away from; a fresh count can be', async () => {
    await q(
      `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, memo)
       VALUES ('2026-12-28', 'BANK', 'MEMBER_CAPITAL', 100000, $1, 'import', 'late entry')`,
      [fund.members.M02],
    );
    expect((await call('GET', '/reconciliations?period=2026-12', cashier)).json().stale).toBe(true);
    expect((await call('POST', '/reconciliations/2026-12/approve', auditor)).json().code).toBe('reconciliation.books_changed');

    await call('POST', '/reconciliations', cashier, {
      period: '2026-12',
      entries: [{ account: 'BANK', actual_balance_paisa: '2300000' }],
      shops: [{ partner_id: shopId, statement_paisa: '300000' }],
    });
    expect((await call('POST', '/reconciliations/2026-12/approve', auditor)).statusCode).toBe(204);
    expect((await call('POST', '/periods/2026-12/lock', auditor)).statusCode).toBe(204);
    expect((await call('GET', '/reconciliations?period=2026-12', cashier)).json()).toMatchObject({ approved: true, stale: false });
  });
});
