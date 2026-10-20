import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createLogger } from '../lib/logger';
import { testEnv, seedFund, type Fund } from '../test/fund-fixture';
import { createTestDb, type TestDb } from '../test/db-harness';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import { remindDuesJob } from './workers/reminders';

/**
 * The due-reminder window is judged on the injected clock, but "is the due near" and the due status
 * use the database's own date, so the clock follows the real date here and the window rule is
 * widened to the whole month.
 */
const clock = createFakeClock(new Date());

let db: TestDb | null;
let fund: Fund;

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  fund = await seedFund(db.admin);
  const today = clock.todayDhaka();
  await db.admin.query(
    `INSERT INTO rules (key, value, valid_from) VALUES ('reminder_start_day','1','2026-01-02'), ('reminder_end_day','31','2026-01-02')`,
  );
  for (const code of ['M02', 'M03'] as const) {
    await db.admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, $2, 'monthly', 1, 500000, $3::date)`,
      [fund.members[code], today.slice(0, 7), today],
    );
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('remind-dues', () => {
  it('skips a member whose payment is waiting for verification and reminds the other', async (ctx) => {
    if (!db) return ctx.skip();
    // M03 has sent money that the cashier has not confirmed yet.
    await db.admin.query(
      `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, trx_id, unallocated_paisa)
       VALUES ($1, 500000, 'bkash', now(), 'pending', 'member_submitted', 'TRX-PENDING', 0)`,
      [fund.members.M03],
    );

    const deps = {
      env: testEnv,
      pool: db.app,
      clock,
      log: createLogger('silent'),
      pushSender: { send: async (t: string[]) => t.map(() => ({ ok: true })) } as unknown as PushSender,
      smsProvider: { send: async () => ({ ok: true }) } as unknown as SmsProvider,
    };
    const { queued } = await remindDuesJob(deps);

    const reminded = await db.admin.query(
      `SELECT DISTINCT m.code FROM notifications n JOIN members m ON m.id = n.member_id
       WHERE n.template = 'due_reminder' ORDER BY 1`,
    );
    expect(reminded.rows.map((r) => r.code)).toEqual(['M02']);
    expect(queued).toBe(1);
  });

  it('reminds again once the pending payment is settled', async (ctx) => {
    if (!db) return ctx.skip();
    await db.admin.query(`UPDATE payments SET status='rejected', reject_reason='test' WHERE trx_id='TRX-PENDING'`);
    const deps = {
      env: testEnv,
      pool: db.app,
      clock,
      log: createLogger('silent'),
      pushSender: { send: async (t: string[]) => t.map(() => ({ ok: true })) } as unknown as PushSender,
      smsProvider: { send: async () => ({ ok: true }) } as unknown as SmsProvider,
    };
    await remindDuesJob(deps);
    const reminded = await db.admin.query(
      `SELECT DISTINCT m.code FROM notifications n JOIN members m ON m.id = n.member_id
       WHERE n.template = 'due_reminder' ORDER BY 1`,
    );
    expect(reminded.rows.map((r) => r.code)).toEqual(['M02', 'M03']);
  });
});
