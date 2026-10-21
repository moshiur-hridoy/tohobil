import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';
import { applyFines } from '../fines/service';
import { computeConsecutiveUnpaidMonths } from '../members/status';
import { executeProposal, type ClientCtx } from '../proposals/service';
import { generateDues } from './service';

const START = new Date('2026-11-05T03:00:00Z'); // 5 Nov 2026, 09:00 in Dhaka
const clock = createFakeClock(START);

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const cashier = {} as TestSession;

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

const call = (method: 'GET' | 'POST', url: string, who: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${who}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const balance = async (account: string): Promise<bigint> =>
  BigInt(((await q(`SELECT natural_balance_paisa::text AS n FROM v_account_balances WHERE code=$1`, [account]))[0]?.n as string | undefined) ?? '0');

const outstanding = async (memberId: string, kind: string): Promise<string | undefined> =>
  (await q(`SELECT outstanding_paisa::text AS o FROM v_due_status WHERE member_id=$1 AND kind=$2`, [memberId, kind]))[0]?.o as string | undefined;

async function actor() {
  const row = (await q(
    `SELECT u.id, u.member_id, m.code AS member_code, m.full_name, u.roles, u.status AS user_status,
            m.status AS member_status, u.totp_enabled, d.id AS device_id
     FROM users u JOIN members m ON m.id = u.member_id
     JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL
     WHERE m.code = 'M01' LIMIT 1`,
  ))[0] as never;
  return { ...(row as object), step_up_at: null } as never;
}

async function approved(payload: Record<string, unknown>): Promise<string> {
  const res = await db!.admin.query(
    `INSERT INTO proposals (type, title, payload, status, finalized_at, created_by)
     VALUES ('special_contribution', 'Land', $1, 'approved', now(), $2) RETURNING id`,
    [JSON.stringify(payload), fund.users.M01],
  );
  return (res.rows[0] as { id: string }).id;
}

async function execute(pid: string) {
  const a = await actor();
  const ctx: ClientCtx = { ip: '127.0.0.1', user: a };
  return executeProposal({ pool: db!.app, clock }, a, pid, {} as never, ctx);
}

async function enrolStepUp(session: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', session.access_token);
  const secret = (enrol.json() as { secret: string }).secret;
  const code = authenticator.clone({ epoch: clock.now().getTime() }).generate(secret);
  const res = await call('POST', '/auth/totp/verify', session.access_token, { code });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

const pay = (memberId: string, amount: string, purpose: string) =>
  call('POST', '/payments/cashier-entry', cashier.access_token, {
    member_id: memberId,
    amount_paisa: amount,
    method: 'cash',
    purpose,
    paid_at: '2026-11-05T03:00:00Z',
  });

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  Object.assign(cashier, await activateSession(app, db, clock, fund, 'M01'));
  await enrolStepUp(cashier);
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

describe('special contribution (constitution 1.4)', () => {
  dbIt('charges per share into capital, apart from the monthly dues, with no fine and no warning', async () => {
    // a due date that has passed is refused
    await expect(execute(await approved({ per_share_paisa: '2000000', due_date: '2026-11-01', reason: 'Land' })))
      .rejects.toMatchObject({ code: 'special.due_in_past' });

    // 20,000 BDT per share, due at the end of December
    await execute(await approved({ per_share_paisa: '2000000', due_date: '2026-12-31', reason: 'Land purchase' }));
    const dues = await q(`SELECT member_id, amount_paisa::text AS a, shares_snapshot FROM dues WHERE kind='special'`);
    expect(dues).toHaveLength(8);
    expect(dues.find((d) => d.member_id === fund.members.M02)).toMatchObject({ a: '8000000', shares_snapshot: 4 });
    expect(dues.find((d) => d.member_id === fund.members.M03)).toMatchObject({ a: '2000000', shares_snapshot: 1 });

    // one per month, never silently merged
    await expect(execute(await approved({ per_share_paisa: '100', due_date: '2026-12-15', reason: 'Second' })))
      .rejects.toMatchObject({ code: 'special.period_taken' });

    // a monthly payment is never applied to the special contribution, even when it is more than the month
    await generateDues({ pool: db!.app, clock }, { period: '2026-11' });
    const m2 = fund.members.M02;
    expect((await pay(m2, '3000000', 'dues')).statusCode).toBe(201); // November is 2,000,000 for 4 shares
    expect(await outstanding(m2, 'monthly')).toBe('0');
    expect(await outstanding(m2, 'special')).toBe('8000000');

    // paid on its own, it goes to capital
    const capital0 = await balance('MEMBER_CAPITAL');
    expect((await pay(m2, '8000000', 'special')).statusCode).toBe(201);
    expect(await outstanding(m2, 'special')).toBe('0');
    expect(await balance('MEMBER_CAPITAL')).toBe(capital0 + 8000000n);

    const m4 = fund.members.M04; // 1 share: November paid, the special contribution not
    expect((await pay(m4, '500000', 'dues')).statusCode).toBe(201);

    // long after the due date: no fine on it, and it does not make a month unpaid
    const later = '2027-01-25';
    await applyFines({ pool: db!.app, clock }, later);
    expect(await q(`SELECT 1 FROM fines f JOIN dues d ON d.id = f.due_id WHERE d.kind = 'special'`)).toHaveLength(0);
    expect(await outstanding(m4, 'special')).toBe('2000000');
    expect(await computeConsecutiveUnpaidMonths(db!.app, m4, later)).toBe(0);

    // the monthly sheet leaves it out; the obligations page lists who still owes it
    const matrix = (await call('GET', '/matrix?from=2026-12&to=2026-12', cashier.access_token)).json();
    const row = matrix.members.find((r: { member_id: string }) => r.member_id === m4);
    expect(row.cells['2026-12']).toBeNull();

    const summary = (await call('GET', '/special-contributions', cashier.access_token)).json();
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toMatchObject({ period: '2026-12', due_date: '2026-12-31', reason: 'Land purchase' });
    expect(summary.items[0].members).toHaveLength(8);
    expect(BigInt(summary.items[0].outstanding_paisa)).toBe(BigInt(summary.items[0].total_paisa) - 8000000n);
  });
});
