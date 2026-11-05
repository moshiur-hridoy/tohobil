import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock, customNoticeSchema } from '@barakah/shared';
import { createLogger } from '../lib/logger';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import type { AuthUser } from '../auth/service';
import type { PushSender } from './providers/push';
import type { SmsProvider } from './providers/sms';
import { sendCustomNotice } from './notice';
import { sendQueuedNotifications } from './service';

// 16:00 in Dhaka: outside quiet hours, so everything goes out at once.
const clock = createFakeClock(new Date('2026-11-05T10:00:00Z'));

let db: TestDb | null;
let fund: Fund;
let cashier: AuthUser;
const pushCalls: Array<{ title?: string; body: string }> = [];
const smsCalls: Array<{ phone: string; body: string }> = [];

function deps() {
  return {
    pool: db!.app,
    clock,
    log: createLogger('silent'),
    pushSender: {
      send: async (tokens: string[], title: string | undefined, body: string) => {
        pushCalls.push({ title, body });
        return tokens.map(() => ({ ok: true }));
      },
    } as unknown as PushSender,
    smsProvider: {
      send: async (phone: string, body: string) => {
        smsCalls.push({ phone, body });
        return { ok: true };
      },
    } as unknown as SmsProvider,
  };
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  fund = await seedFund(db.admin);
  const dev = await db.admin.query(
    `INSERT INTO devices (user_id, install_id, platform, label, fcm_token, push_enabled)
     VALUES ($1, 'install-cashier', 'android', 'Cashier phone', 'fcm-cashier', true) RETURNING id`,
    [fund.users.M01],
  );
  await db.admin.query(
    `INSERT INTO devices (user_id, install_id, platform, label, fcm_token, push_enabled)
     VALUES ($1, 'install-m02', 'android', 'M02 phone', 'fcm-m02', true)`,
    [fund.users.M02],
  );
  // M08 has left the fund: a notice to everyone must not reach them.
  await db.admin.query(`UPDATE members SET status = 'exited', exited_on = '2026-10-01' WHERE id = $1`, [fund.members.M08]);
  cashier = {
    id: fund.users.M01,
    member_id: fund.members.M01,
    member_code: 'M01',
    full_name: 'Cashier',
    roles: ['member', 'cashier'],
    user_status: 'active',
    member_status: 'active',
    totp_enabled: false,
    device_id: (dev.rows[0] as { id: string }).id,
    step_up_at: null,
  };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('custom notice', () => {
  it('needs a title, a message and, for chosen members, at least one member', () => {
    expect(customNoticeSchema.safeParse({ title: ' ', message: 'x', audience: 'all' }).success).toBe(false);
    expect(customNoticeSchema.safeParse({ title: 'a', message: 'x', audience: 'selected' }).success).toBe(false);
    const ok = customNoticeSchema.parse({ title: ' মিটিং ', message: 'শুক্রবার', audience: 'all' });
    expect(ok).toMatchObject({ title: 'মিটিং', sms: false, member_ids: [] });
  });

  it('pushes to every member still in the fund, with the title, and logs the text', async (ctx) => {
    if (!db) return ctx.skip();
    const input = customNoticeSchema.parse({ title: 'মিটিং', message: 'শুক্রবার বিকেলে মিটিং।', audience: 'all' });
    const res = await sendCustomNotice(deps(), cashier, input, '127.0.0.1');
    expect(res.recipients).toBe(7);

    const rows = await db.admin.query(
      `SELECT m.code, n.channel, n.payload FROM notifications n JOIN members m ON m.id = n.member_id
       WHERE n.template = 'custom_notice' ORDER BY m.code`,
    );
    expect(rows.rows.map((r) => r.code)).not.toContain('M08');
    expect(rows.rows.every((r) => r.channel === 'push')).toBe(true);
    expect(rows.rows[0].payload).toMatchObject({ title: 'মিটিং', _title: 'মিটিং', _body: 'শুক্রবার বিকেলে মিটিং।' });

    await sendQueuedNotifications(deps());
    expect(pushCalls).toContainEqual({ title: 'মিটিং', body: 'শুক্রবার বিকেলে মিটিং।' });

    const log = await db.admin.query(`SELECT after FROM audit_log WHERE action = 'notification.custom_notice'`);
    expect(log.rows[0].after).toMatchObject({ message: 'শুক্রবার বিকেলে মিটিং।', recipients: 7, sms: false });
  });

  it('adds SMS only when asked, then to everyone picked, with the title in front', async (ctx) => {
    if (!db) return ctx.skip();
    const input = customNoticeSchema.parse({
      title: 'জরুরি',
      message: 'আজ টাকা জমা দিন।',
      audience: 'selected',
      member_ids: [fund.members.M02, fund.members.M03, fund.members.M08],
      sms: true,
    });
    const res = await sendCustomNotice(deps(), cashier, input);
    // M08 has left, so only two are reached.
    expect(res.recipients).toBe(2);
    const sms = await db.admin.query(
      `SELECT m.code FROM notifications n JOIN members m ON m.id = n.member_id
       WHERE n.template = 'custom_notice' AND n.channel = 'sms'`,
    );
    expect(sms.rows.map((r) => r.code).sort()).toEqual(['M02', 'M03']);

    smsCalls.length = 0;
    await sendQueuedNotifications(deps());
    expect(smsCalls.map((c) => c.body)).toEqual(['জরুরি: আজ টাকা জমা দিন।', 'জরুরি: আজ টাকা জমা দিন।']);
  });

  it('refuses a notice that nobody can receive', async (ctx) => {
    if (!db) return ctx.skip();
    const input = customNoticeSchema.parse({ title: 'x', message: 'y', audience: 'selected', member_ids: [fund.members.M08] });
    await expect(sendCustomNotice(deps(), cashier, input)).rejects.toMatchObject({ code: 'notification.no_recipients' });
  });
});
