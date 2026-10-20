import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund } from '../test/fund-fixture';
import { zakatNoticeJob } from './workers/zakat';

const clock = createFakeClock(new Date('2027-02-10T04:00:00Z')); // 10 Feb 2027, Dhaka

let db: TestDb | null;

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  await seedFund(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('zakat notice job', () => {
  it('sends nothing until the cashier has set a date, and nothing on any other day', async (ctx) => {
    if (!db) return ctx.skip();
    expect(await zakatNoticeJob({ pool: db.app, clock })).toEqual({ queued: 0 });
    await db.admin.query(`INSERT INTO settings (key, value) VALUES ('zakat_notice_date', '"2027-02-11"')`);
    expect(await zakatNoticeJob({ pool: db.app, clock })).toEqual({ queued: 0 });
  });

  it('on the day, notifies every active member once, however often the job runs', async (ctx) => {
    if (!db) return ctx.skip();
    await db.admin.query(`UPDATE settings SET value = '"2027-02-10"' WHERE key = 'zakat_notice_date'`);
    expect(await zakatNoticeJob({ pool: db.app, clock })).toEqual({ queued: 8 });
    expect(await zakatNoticeJob({ pool: db.app, clock })).toEqual({ queued: 0 });
    const rows = await db.admin.query(`SELECT payload->>'_body' AS body FROM notifications WHERE template = 'zakat_info'`);
    expect(rows.rows).toHaveLength(8);
    expect(rows.rows[0]!.body).toContain('যাকাত'); // figures only; the member calculates their own zakat
  });
});
