import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';
import { createFakeClock } from '@barakah/shared';
import { autoJobsOn } from '../lib/env';
import { computeConsecutiveUnpaidMonths } from '../members/status';
import { skipStaleNotifications } from '../notifications/repo';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import { CRON_QUEUE, createJobQueues } from './queues';
import { generateDuesJob } from './workers/dues';
import { applyFinesJob } from './workers/fines';

/** The scheduler really runs, and catches up safely after a missed day (ASSUMPTIONS 136). */
describe('scheduled jobs', () => {
  let db: TestDb | null = null;
  let fund: Fund;
  const at = (day: string) => createFakeClock(new Date(`${day}T06:00:00Z`));

  beforeAll(async () => {
    db = await createTestDb();
    if (db) fund = await seedFund(db.admin);
  }, 120_000);
  afterAll(async () => {
    await db?.close();
  });

  const count = async (sql: string) => Number((await db!.admin.query(sql)).rows[0].n);

  it('is on in development and off in production until switched on', () => {
    expect(autoJobsOn({ NODE_ENV: 'development', AUTO_JOBS: '' })).toBe(true);
    expect(autoJobsOn({ NODE_ENV: 'production', AUTO_JOBS: '' })).toBe(false);
    expect(autoJobsOn({ NODE_ENV: 'production', AUTO_JOBS: 'on' })).toBe(true);
    expect(autoJobsOn({ NODE_ENV: 'development', AUTO_JOBS: 'off' })).toBe(false);
  });

  it('forwards a cron message to its queue while pg-boss runs as the app role', async (ctx) => {
    if (!db) return ctx.skip();
    const on = (pool: TestDb['app']) => ({ executeSql: (text: string, values: unknown[]) => pool.query(text, values) });
    const owner = new PgBoss({ db: on(db.admin), supervise: false, schedule: false });
    await owner.start();
    await createJobQueues(owner);
    await owner.stop({ graceful: false });

    const app = new PgBoss({ db: on(db.app), cronWorkerIntervalSeconds: 1 });
    app.on('error', () => undefined);
    await app.start();
    try {
      let ran!: () => void;
      const done = new Promise<void>((resolve) => (ran = resolve));
      await app.work('send-notifications', { pollingIntervalSeconds: 0.5 }, async () => ran());
      // Exactly what the cron timer does once a schedule is due.
      await app.send(CRON_QUEUE, { name: 'send-notifications' });
      await done;
    } finally {
      await app.stop({ graceful: false });
    }
  }, 40_000);

  it('creates the month late if the 1st was missed, but never on or after the due date', async (ctx) => {
    if (!db) return ctx.skip();
    await generateDuesJob({ pool: db.app, clock: at('2026-03-20') });
    expect(await count(`SELECT count(*) AS n FROM dues`)).toBe(0);
    await generateDuesJob({ pool: db.app, clock: at('2026-03-07') });
    expect(await count(`SELECT count(*) AS n FROM dues WHERE period = '2026-03'`)).toBe(8);
  });

  it('adds the fines on a later day if the fine day was missed, once, from the chosen date', async (ctx) => {
    if (!db) return ctx.skip();
    await generateDuesJob({ pool: db.app, clock: at('2026-04-01') });
    const clock = at('2026-04-28');
    expect(await applyFinesJob({ pool: db.app, clock, finesFrom: '2026-04-01' })).toEqual({ applied: 8 });
    expect(await count(`SELECT count(*) AS n FROM fines f JOIN dues d ON d.id = f.due_id WHERE d.period = '2026-03'`)).toBe(0);
    expect(await applyFinesJob({ pool: db.app, clock })).toEqual({ applied: 8 });
    expect(await applyFinesJob({ pool: db.app, clock })).toEqual({ applied: 0 });
  });

  it('does not count a month as unpaid before its due date', async (ctx) => {
    if (!db) return ctx.skip();
    await generateDuesJob({ pool: db.app, clock: at('2026-05-01') });
    const member = fund.members.M03;
    const march = await computeConsecutiveUnpaidMonths(db.app, member, '2026-05-20');
    expect(march).toBe(2);
    expect(await computeConsecutiveUnpaidMonths(db.app, member, '2026-05-21')).toBe(3);
  });

  it('gives up on old queued notifications and leaves recent ones', async (ctx) => {
    if (!db) return ctx.skip();
    for (const [key, when] of [['old', '2026-05-01'], ['new', '2026-05-10']] as const) {
      await db.admin.query(
        `INSERT INTO notifications (member_id, template, channel, payload, dedupe_key, scheduled_for)
         VALUES ($1, 'due_reminder', 'push', '{}'::jsonb, $2, $3)`,
        [fund.members.M03, key, `${when}T06:00:00Z`],
      );
    }
    expect(await skipStaleNotifications(db.app, new Date('2026-05-08T06:00:00Z'))).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM notifications WHERE dedupe_key = 'new' AND status = 'queued'`)).toBe(1);
  });
});
