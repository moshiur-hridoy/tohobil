import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund } from '../test/fund-fixture';
import { runBackupWatch } from './status';

let db: TestDb | null;
let dir: string;

// 2026-11-06 is a Friday; 09:15 in Dhaka is 03:15 UTC.
const friday = createFakeClock(new Date('2026-11-06T03:15:00Z'));
const thursday = createFakeClock(new Date('2026-11-05T03:15:00Z'));

async function status(file: string, value: unknown): Promise<void> {
  await writeFile(join(dir, file), JSON.stringify(value));
}

async function sent(): Promise<Array<{ template: string; channel: string; body: string }>> {
  const res = await db!.admin.query(
    `SELECT template, channel, payload->>'_body' AS body FROM notifications ORDER BY template, channel`,
  );
  return res.rows as Array<{ template: string; channel: string; body: string }>;
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  await seedFund(db.admin);
}, 120_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'backup-watch-'));
  if (db) await db.admin.query(`DELETE FROM notifications`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await db?.close();
});

describe('backup watch', () => {
  it('stays quiet without a sidecar outside production', async (ctx) => {
    if (!db) return ctx.skip();
    expect(await runBackupWatch({ pool: db.app, clock: thursday, statusDir: dir, production: false })).toBe('no_sidecar');
    expect(await sent()).toEqual([]);
  });

  it('in production, no status file at all alerts the cashier and auditor by push and SMS', async (ctx) => {
    if (!db) return ctx.skip();
    expect(await runBackupWatch({ pool: db.app, clock: thursday, statusDir: dir, production: true })).toBe('missing');
    const rows = await sent();
    // Two people, two channels each.
    expect(rows.filter((r) => r.template === 'backup_missing')).toHaveLength(4);
    expect(rows[0]!.body).toContain('অজানা');
  });

  it('alerts when the last good backup is older than 26 hours, once a day', async (ctx) => {
    if (!db) return ctx.skip();
    await status('status.json', { ok: true, finished: '2026-11-03T20:00:00Z', size: 5_000_000 });
    await runBackupWatch({ pool: db.app, clock: thursday, statusDir: dir, production: true });
    await runBackupWatch({ pool: db.app, clock: thursday, statusDir: dir, production: true });
    const rows = await sent();
    expect(rows).toHaveLength(4);
    expect(rows[0]!.body).toContain('৪ নভেম্বর ২০২৬');
  });

  it('a fresh backup on a weekday sends nothing', async (ctx) => {
    if (!db) return ctx.skip();
    await status('status.json', { ok: true, finished: '2026-11-04T20:00:00Z', size: 5_000_000 });
    expect(await runBackupWatch({ pool: db.app, clock: thursday, statusDir: dir, production: true })).toBe('ok');
    expect(await sent()).toEqual([]);
  });

  it('on Friday a fresh backup sends the weekly report by push only', async (ctx) => {
    if (!db) return ctx.skip();
    await status('status.json', { ok: true, finished: '2026-11-05T20:00:00Z', size: 12_582_912 });
    await status('restore-status.json', { ok: true, finished: '2026-11-01T21:40:00Z' });
    expect(await runBackupWatch({ pool: db.app, clock: friday, statusDir: dir, production: true })).toBe('weekly_report');
    const rows = await sent();
    expect(rows.map((r) => `${r.template}:${r.channel}`)).toEqual(['backup_weekly_ok:push', 'backup_weekly_ok:push']);
    expect(rows[0]!.body).toContain('১২ MB');
    expect(rows[0]!.body).toContain('সফল (২ নভেম্বর ২০২৬)');
  });

  it('a failed last backup is an alert, not a report, even on Friday', async (ctx) => {
    if (!db) return ctx.skip();
    await status('status.json', { ok: false, finished: '2026-11-05T20:05:00Z', error: 'x' });
    expect(await runBackupWatch({ pool: db.app, clock: friday, statusDir: dir, production: true })).toBe('missing');
    expect((await sent()).every((r) => r.template === 'backup_missing')).toBe(true);
  });
});
