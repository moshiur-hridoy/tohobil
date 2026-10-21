import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { createLogger } from '../lib/logger';
import { seedFund, type Fund } from '../test/fund-fixture';
import { createTestDb, type TestDb } from '../test/db-harness';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import {
  cancelMeeting,
  createMeeting,
  draftMonthlyMeeting,
  getMeeting,
  recordAttendance,
  remindMeetings,
  scheduleMeeting,
} from './service';

const clock = createFakeClock(new Date('2026-11-05T06:00:00Z'));

let db: TestDb | null;
let fund: Fund;

const deps = () => ({
  pool: db!.app,
  clock,
  notifications: {
    pool: db!.app,
    clock,
    log: createLogger('silent'),
    pushSender: { send: async (t: string[]) => t.map(() => ({ ok: true })) } as unknown as PushSender,
    smsProvider: { send: async () => ({ ok: true }) } as unknown as SmsProvider,
  },
});
const actor = () => ({ userId: fund.users.M01 });

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  fund = await seedFund(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('meetings', () => {
  it('drafts one meeting a month from five days before the window', async (ctx) => {
    if (!db) return ctx.skip();
    // window starts on the 10th: the 4th is too early, the 5th drafts, a second run does nothing
    clock.set(new Date('2026-11-04T06:00:00Z'));
    expect((await draftMonthlyMeeting(deps())).created).toBeNull();
    clock.set(new Date('2026-11-05T06:00:00Z'));
    const first = await draftMonthlyMeeting(deps());
    expect(first.created).not.toBeNull();
    expect((await draftMonthlyMeeting(deps())).created).toBeNull();

    await scheduleMeeting(deps(), actor(), first.created!, { date: '2026-11-10', time: '21:30', link: 'https://meet.example/abc' });
    const m = await getMeeting(db.app, first.created!);
    expect(m).toMatchObject({ status: 'scheduled', date: '2026-11-10', time: '21:30' });
    expect(m.attendance).toHaveLength(8);
  });

  it('reminds a day before and an hour before, once each', async (ctx) => {
    if (!db) return ctx.skip();
    // 21:30 Dhaka on the 10th is 15:30Z; a day before, then an hour before
    clock.set(new Date('2026-11-09T16:00:00Z'));
    expect((await remindMeetings(deps())).queued).toBe(8);
    expect((await remindMeetings(deps())).queued).toBe(0);
    clock.set(new Date('2026-11-10T15:00:00Z'));
    expect((await remindMeetings(deps())).queued).toBe(8);
  });

  it('refuses attendance before the meeting and fines the third unexcused absence in a row', async (ctx) => {
    if (!db) return ctx.skip();
    const everyone = (status: (code: string) => 'present' | 'absent_excused' | 'absent_unexcused') =>
      Object.entries(fund.members).map(([code, id]) => ({ member_id: id, status: status(code) }));

    clock.set(new Date('2026-11-10T15:00:00Z'));
    const nov = (await db.app.query(`SELECT id FROM meetings WHERE status = 'scheduled'`)).rows[0] as { id: string };
    await expect(recordAttendance(deps(), actor(), nov.id, { items: everyone(() => 'present') })).rejects.toMatchObject({
      code: 'meeting.not_started',
    });

    // M02 misses three meetings without leave; M03 misses two, then asks for leave
    const plan: Array<[string, string, Record<string, 'absent_excused' | 'absent_unexcused'>]> = [
      ['2026-11-10', '21:30', { M02: 'absent_unexcused', M03: 'absent_unexcused' }],
      ['2026-12-10', '21:30', { M02: 'absent_unexcused', M03: 'absent_unexcused' }],
      ['2027-01-10', '21:30', { M02: 'absent_unexcused', M03: 'absent_excused' }],
    ];
    let lastFines: Array<{ member_id: string; amount_paisa: bigint }> = [];
    for (const [i, [date, time, absent]] of plan.entries()) {
      const id = i === 0 ? nov.id : await createMeeting(deps(), actor(), { date, time });
      clock.set(new Date(`${date}T17:00:00Z`));
      lastFines = (await recordAttendance(deps(), actor(), id, { items: everyone((c) => absent[c] ?? 'present') })).fines;
      if (i < 2) expect(lastFines).toEqual([]);
    }
    expect(lastFines).toEqual([expect.objectContaining({ member_id: fund.members.M02, amount_paisa: 50000n })]);

    const fine = (await db.app.query(`SELECT kind, amount_paisa::text FROM fines WHERE member_id = $1`, [fund.members.M02])).rows;
    expect(fine).toEqual([{ kind: 'absence', amount_paisa: '50000' }]);
    const notified = await db.app.query(`SELECT 1 FROM notifications WHERE template = 'absence_fine' AND member_id = $1`, [fund.members.M02]);
    expect(notified.rowCount).toBeGreaterThan(0);
  });

  it('closes a meeting once and never reopens a held or cancelled one', async (ctx) => {
    if (!db) return ctx.skip();
    const held = (await db.app.query(`SELECT id FROM meetings WHERE status = 'held' LIMIT 1`)).rows[0] as { id: string };
    await expect(
      recordAttendance(deps(), actor(), held.id, { items: [{ member_id: fund.members.M01, status: 'present' }] }),
    ).rejects.toMatchObject({ code: 'meeting.wrong_status' });

    const id = await createMeeting(deps(), actor(), { date: '2027-02-10', time: '21:00' });
    await cancelMeeting(deps(), actor(), id, 'Eid');
    await expect(scheduleMeeting(deps(), actor(), id, { date: '2027-02-11', time: '21:00' })).rejects.toMatchObject({
      code: 'meeting.wrong_status',
    });
  });
});
