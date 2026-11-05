import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { computeNav as navBreakdown } from '../nav/service';
import { computeNav } from './nav';

// Assets cannot be deleted, so this file has its own database: the assets it leaves behind would
// make every later valuation look stale elsewhere.
let db: TestDb | null;
const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;
const breakdownOn = (iso: string) => navBreakdown({ pool: db!.app, clock: createFakeClock(new Date(`${iso}T03:00:00Z`)) });

beforeAll(async () => {
  db = await createTestDb();
}, 180_000);

afterAll(async () => {
  await db?.close();
});

function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn();
  });
}

// The purchase counts as the first valuation (docs/ASSUMPTIONS.md 119).
describe('stale valuations', () => {
  dbIt('an asset bought within the year and never valued is not stale; a year and more later it is', async () => {
    const [asset] = (await q(
      `INSERT INTO assets (kind, name, cost_paisa, status, acquired_on)
       VALUES ('gold', 'New Gold', 1000000, 'held', '2026-10-01') RETURNING id`,
    )) as Array<{ id: string }>;

    expect((await computeNav(db!.admin, '2026-11-05')).stale_valuations).toBe(false);
    expect((await breakdownOn('2026-11-05')).stale_valuations).toEqual([]);

    expect((await computeNav(db!.admin, '2027-10-02')).stale_valuations).toBe(true);
    expect((await breakdownOn('2027-10-02')).stale_valuations).toEqual([
      { id: asset!.id, name: 'New Gold', partner_id: null, latest_as_of: null, acquired_on: '2026-10-01' },
    ]);
  });

  dbIt('an asset with neither a valuation nor a purchase date is stale', async () => {
    await q(`INSERT INTO assets (kind, name, cost_paisa, status) VALUES ('gold', 'Undated Gold', 1000000, 'held')`);
    expect((await computeNav(db!.admin, '2026-11-05')).stale_valuations).toBe(true);
    expect((await breakdownOn('2026-11-05')).stale_valuations.map((s) => s.name)).toEqual(['Undated Gold']);
  });
});
