import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { notifyMember, sendQueuedNotifications } from './service';
import { createLogger } from '../lib/logger';
import type { PushSender } from './providers/push';
import type { SmsProvider } from './providers/sms';

const clock = createFakeClock(new Date('2026-10-20T10:00:00Z'));

interface PushCall {
  tokens: string[];
  title?: string;
  body: string;
}

interface SmsCall {
  phone: string;
  body: string;
}

function fakePushSender(calls: PushCall[]): PushSender {
  return {
    send: async (tokens: string[], title: string | undefined, body: string) => {
      calls.push({ tokens, title, body });
      return tokens.map(() => ({ ok: true }));
    },
  } as unknown as PushSender;
}

function fakeSmsProvider(calls: SmsCall[]): SmsProvider {
  return {
    send: async (phone: string, body: string) => {
      calls.push({ phone, body });
      return { ok: true };
    },
  } as unknown as SmsProvider;
}

function makeDeps(db: TestDb, pushCalls: PushCall[], smsCalls: SmsCall[]) {
  return {
    pool: db.app,
    clock,
    log: createLogger('silent'),
    pushSender: fakePushSender(pushCalls),
    smsProvider: fakeSmsProvider(smsCalls),
  };
}

async function insertMemberWithDevice(db: TestDb): Promise<{ memberId: string; userId: string }> {
  const m = await db.admin.query(
    `INSERT INTO members (code, full_name, phone, joined_on, notify_prefs)
     VALUES ('M99', 'Notify Test', '+8801700000099', '2026-01-01', '{"push":true,"sms":true,"digits":"bn"}') RETURNING id`,
  );
  const memberId = (m.rows[0] as { id: string }).id;
  const u = await db.admin.query(
    `INSERT INTO users (member_id, roles) VALUES ($1, '{member}') RETURNING id`,
    [memberId],
  );
  const userId = (u.rows[0] as { id: string }).id;
  await db.admin.query(
    `INSERT INTO devices
       (user_id, install_id, platform, label, fcm_token, push_enabled)
     VALUES ($1, 'install-99', 'android', 'Test phone', 'fcm-token-99', true)`,
    [userId],
  );
  return { memberId, userId };
}

describe('notification engine', () => {
  let db: TestDb | null;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it('queues push and SMS rows, then sends them through the providers', async (ctx) => {
    if (!db) return ctx.skip();

    const { memberId } = await insertMemberWithDevice(db);
    const pushCalls: PushCall[] = [];
    const smsCalls: SmsCall[] = [];
    const deps = makeDeps(db, pushCalls, smsCalls);

    await notifyMember(deps, db.app, {
      memberId,
      template: 'payment_confirmed',
      vars: { name: 'Notify Test', amount: '১০০' },
    });

    const queued = await db.app.query(
      `SELECT channel, status FROM notifications WHERE member_id = $1 ORDER BY channel`,
      [memberId],
    );
    expect(queued.rows).toHaveLength(2);

    const sent = await sendQueuedNotifications(deps);
    expect(sent).toBe(2);

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toMatchObject({
      tokens: ['fcm-token-99'],
      body: expect.stringContaining('গৃহীত'),
    });

    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0]).toMatchObject({
      phone: '+8801700000099',
      body: expect.stringContaining('গৃহীত'),
    });

    const final = await db.app.query(
      `SELECT channel, status FROM notifications WHERE member_id = $1 ORDER BY channel`,
      [memberId],
    );
    expect((final.rows as Array<{ channel: string; status: string }>).map((r) => `${r.channel}:${r.status}`)).toEqual([
      'push:sent',
      'sms:sent',
    ]);
  });

  it('skips push when the member has no usable tokens', async (ctx) => {
    if (!db) return ctx.skip();

    const m = await db.admin.query(
      `INSERT INTO members (code, full_name, phone, joined_on, notify_prefs)
       VALUES ('M98', 'No Device', '+8801700000098', '2026-01-01', '{"push":true,"sms":true,"digits":"bn"}') RETURNING id`,
    );
    const memberId = (m.rows[0] as { id: string }).id;
    await db.admin.query(`INSERT INTO users (member_id, roles) VALUES ($1, '{member}')`, [memberId]);

    const pushCalls: PushCall[] = [];
    const smsCalls: SmsCall[] = [];
    const deps = makeDeps(db, pushCalls, smsCalls);

    await notifyMember(deps, db.app, {
      memberId,
      template: 'payment_confirmed',
      vars: { name: 'No Device', amount: '৫০' },
    });

    const sent = await sendQueuedNotifications(deps);
    expect(sent).toBe(2);

    const rows = await db.app.query(
      `SELECT channel, status FROM notifications WHERE member_id = $1 ORDER BY channel`,
      [memberId],
    );
    expect((rows.rows as Array<{ channel: string; status: string }>).map((r) => `${r.channel}:${r.status}`)).toEqual([
      'push:skipped',
      'sms:sent',
    ]);
    expect(pushCalls).toHaveLength(0);
    expect(smsCalls).toHaveLength(1);
  });
});
