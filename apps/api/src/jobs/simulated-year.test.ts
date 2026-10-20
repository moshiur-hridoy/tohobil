import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { addConfirmedPayment, seedFund, type Fund } from '../test/fund-fixture';
import { generateDuesJob } from './workers/dues';
import { applyFinesJob } from './workers/fines';

/**
 * A simulated 2026: the dues and fines jobs run once a day (twice for dues, to prove idempotence)
 * against a fake clock. Spec rules: dues generated on the 1st, due on the 20th, fines on the 21st,
 * 500 BDT per share and 50 BDT fine per share. Nobody pays except M03, who pays March in full.
 */
const clock = createFakeClock(new Date('2025-12-31T18:10:00Z')); // 1 Jan 2026, 00:10 in Dhaka
const DAY = 24 * 3600_000;

let db: TestDb | null;
let fund: Fund;

const count = async (sql: string, params: unknown[] = []) =>
  Number(((await db!.admin.query(sql, params)).rows[0] as { n: string }).n);

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  fund = await seedFund(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('simulated year of scheduled jobs', () => {
  it('generates each month once, fines each overdue due once, on the 21st', async (ctx) => {
    if (!db) return ctx.skip();
    const deps = { pool: db.app, clock };
    const fineCountByMonthEnd: number[] = [];

    for (let day = 0; day < 365; day++) {
      const today = clock.todayDhaka();

      await generateDuesJob(deps);
      await generateDuesJob(deps); // a second run on the same day creates nothing
      await applyFinesJob(deps);

      if (today === '2026-03-10') {
        // M03 (1 share) pays March in full, on time.
        const due = await db.admin.query(
          `SELECT id FROM dues WHERE member_id=$1 AND period='2026-03' AND kind='monthly'`,
          [fund.members.M03],
        );
        const paymentId = await addConfirmedPayment(db.admin, fund.members.M03, 500_000, {
          confirmedAt: '2026-03-10T06:00:00Z',
        });
        await db.admin.query(
          `INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1,$2,500000)`,
          [paymentId, (due.rows[0] as { id: string }).id],
        );
        await db.admin.query(`UPDATE payments SET unallocated_paisa = 0 WHERE id=$1`, [paymentId]);
      }

      if (/-(0[1-9]|1[0-2])-(28|29|30|31)$/.test(today) && today.slice(8) === lastDay(today)) {
        fineCountByMonthEnd.push(await count(`SELECT count(*) AS n FROM fines`));
      }
      clock.advance(DAY);
    }

    // 12 monthly dues per member, never duplicated by the repeated daily runs.
    expect(await count(`SELECT count(*) AS n FROM dues WHERE kind='monthly'`)).toBe(12 * 8);
    expect(
      await count(
        `SELECT count(*) AS n FROM (SELECT member_id, period FROM dues WHERE kind='monthly'
           GROUP BY 1,2 HAVING count(*) > 1) x`,
      ),
    ).toBe(0);

    // Fines land on the 21st after each due date (the 20th): 8 per month, minus M03's paid March.
    // A month-end sample therefore shows 8 * months so far, less one from March onward.
    expect(fineCountByMonthEnd).toEqual(
      Array.from({ length: 12 }, (_, i) => 8 * (i + 1) - (i >= 2 ? 1 : 0)),
    );

    // One fine per due, share-weighted, nothing for the paid due.
    expect(await count(`SELECT count(*) AS n FROM fines`)).toBe(95);
    expect(
      await count(`SELECT count(*) AS n FROM (SELECT due_id FROM fines GROUP BY 1 HAVING count(*) > 1) x`),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM fines f JOIN dues d ON d.id=f.due_id
         WHERE d.member_id=$1 AND d.period='2026-03'`,
        [fund.members.M03],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM fines f JOIN dues d ON d.id=f.due_id
         WHERE f.amount_paisa <> d.shares_snapshot * 50000`,
      ),
    ).toBe(0);
  }, 300_000);
});

function lastDay(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
}
