import { appendFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { generateDues } from '../dues/service';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

/**
 * Performance sanity (Phase 6): with 100,000 ledger rows the main screens must answer in under 300 ms (p95).
 * Slow to set up, so it only runs on request:  pnpm perf
 */
const RUN = process.env.PERF === '1';
const LEDGER_ROWS = Number(process.env.PERF_ROWS ?? 100_000);
const P95_BUDGET_MS = 300;
/** The test runner swallows console output, so the table is also written here. */
const REPORT = process.env.PERF_REPORT ?? 'perf-latest.txt';
const report = (text: string): void => appendFileSync(REPORT, `${text}\n`);
const SAMPLES = 40;

const clock = createFakeClock(new Date('2026-12-28T04:00:00Z'));
let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
let member: TestSession;

const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

async function measure(url: string, samples = SAMPLES): Promise<{ p95: number; max: number; status: number }> {
  const times: number[] = [];
  let status = 0;
  await app.inject({ url: `/api/v1${url}`, headers: { authorization: `Bearer ${member.access_token}` } }); // warm up
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const res = await app.inject({ url: `/api/v1${url}`, headers: { authorization: `Bearer ${member.access_token}` } });
    times.push(performance.now() - t0);
    status = res.statusCode;
  }
  return { p95: p95(times), max: Math.max(...times), status };
}

beforeAll(async () => {
  if (!RUN) return;
  writeFileSync(REPORT, `${new Date().toISOString()}  ${LEDGER_ROWS} ledger rows, budget p95 ${P95_BUDGET_MS} ms\n`);
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: { ...testEnv, RATE_LIMIT_PER_MINUTE: 100000 } as never, db: db.app, clock });
  fund = await seedFund(db.admin);
  member = await activateSession(app, db, clock, fund, 'M02');
  for (let m = 1; m <= 12; m++) await generateDues({ pool: db.app, clock }, { period: `2026-${String(m).padStart(2, '0')}` });
  const ids = Object.values(fund.members);
  await db.admin.query(
    `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, memo)
     SELECT date '2026-01-01' + (g % 300),
            (ARRAY['CASH','BANK','BKASH','NAGAD'])[1 + g % 4], 'MEMBER_CAPITAL', 100 + g % 900,
            ($1::uuid[])[1 + g % $2], 'import', 'perf row ' || g
     FROM generate_series(1, $3) g`,
    [ids, ids.length, LEDGER_ROWS],
  );
  await db.admin.query('ANALYZE');
}, 900_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe.skipIf(!RUN)(`p95 under ${P95_BUDGET_MS} ms with ${LEDGER_ROWS} ledger rows`, () => {
  const memberId = () => fund.members.M02;
  const endpoints = (): Array<[string, string]> => [
    ['ledger, newest 50', '/ledger?limit=50'],
    ['ledger, one account', '/ledger?limit=50&account=BANK'],
    ['ledger, one member', `/ledger?limit=50&member_id=${memberId()}`],
    ['ledger, a date range', '/ledger?limit=50&from=2026-03-01&to=2026-03-31'],
    ['account balances', '/accounts/balances'],
    ['NAV', '/nav'],
    ['matrix (12 months)', '/matrix?from=2026-01&to=2026-12'],
    ['members', '/members'],
    ['dues', '/dues'],
    ['payments', '/payments'],
    ['me', '/me'],
    ['assets', '/assets'],
    ['proposals', '/proposals'],
    ['periods', '/periods?year=2026'],
  ];

  it('main endpoints', async (ctx) => {
    if (!db) return ctx.skip();
    const rows: string[] = [];
    const failures: string[] = [];
    for (const [name, url] of endpoints()) {
      const r = await measure(url);
      rows.push(`${name.padEnd(24)} p95 ${r.p95.toFixed(1).padStart(7)} ms   max ${r.max.toFixed(1).padStart(7)} ms   HTTP ${r.status}`);
      if (r.status !== 200) failures.push(`${name}: HTTP ${r.status}`);
      else if (r.p95 > P95_BUDGET_MS) failures.push(`${name}: p95 ${r.p95.toFixed(0)} ms`);
    }
    report(rows.join('\n'));
    expect(failures).toEqual([]);
  }, 300_000);

  it('whole-ledger operations stay usable (not held to the 300 ms budget)', async (ctx) => {
    if (!db) return ctx.skip();
    const verify = await measure('/ledger/verify', 1);
    const csv = await measure('/reports/export.csv?entity=ledger', 1);
    report(`ledger verify: ${verify.max.toFixed(0)} ms, full ledger CSV: ${csv.max.toFixed(0)} ms`);
    expect(verify.max).toBeLessThan(15_000);
    expect(csv.max).toBeLessThan(15_000);
  }, 120_000);
});

it.skipIf(RUN)('is skipped unless PERF=1 (run `pnpm perf`)', () => {
  expect(RUN).toBe(false);
});
