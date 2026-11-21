import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createFakeClock } from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { generateDues } from '../dues/service';
import { ConsolePushSender } from '../notifications/providers/push';
import { ConsoleSmsProvider } from '../notifications/providers/sms';
import {
  approveApproval,
  cashierEntry,
  confirmPayment,
  rejectPayment,
  requestReversal,
  submitPayment,
  type PaymentDeps,
} from '../payments/service';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type FixtureCode, type Fund } from '../test/fund-fixture';
import { applyFines, lastFineRun, listFineCancellations } from './service';

// ASSUMPTIONS 130: money that arrived by the due date but was recorded after the fine job ran.
// November 2026: due on the 20th, the fine job runs at 00:05 on the 21st (Asia/Dhaka).
const clock = createFakeClock(new Date('2026-11-05T06:00:00Z'));
const at = (dhaka: string) => clock.set(new Date(`${dhaka}+06:00`));
const ctx = { ip: '127.0.0.1' };

let db: TestDb | null;
let fund: Fund;
let deps: PaymentDeps;

function user(code: FixtureCode): AuthUser {
  return {
    id: fund.users[code],
    member_id: fund.members[code],
    member_code: code,
    full_name: `Member ${code}`,
    roles: code === 'M01' ? ['member', 'cashier'] : code === 'M07' ? ['member', 'auditor'] : ['member'],
    user_status: 'active',
    member_status: 'active',
    totp_enabled: false,
    device_id: '11111111-1111-1111-1111-111111111111',
    step_up_at: null,
  };
}

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

/** November's monthly due and its fine for one member. */
async function november(code: FixtureCode) {
  const due = (await q(
    `SELECT due_id, amount_paisa::text AS amount, status FROM v_due_status
     WHERE member_id = $1 AND period = '2026-11' AND kind = 'monthly'`,
    [fund.members[code]],
  ))[0] as { due_id: string; amount: string; status: string };
  const fine = (await q(
    `SELECT s.fine_id, s.amount_paisa::text AS amount, s.outstanding_paisa::text AS outstanding, s.cancelled
     FROM v_fine_status s WHERE s.due_id = $1`,
    [due.due_id],
  ))[0] as { fine_id: string; amount: string; outstanding: string; cancelled: boolean } | undefined;
  return { due, fine };
}

const entry = (code: FixtureCode, amount: string, paidOn: string, note?: string) =>
  cashierEntry(deps, user('M01'), {
    member_id: fund.members[code],
    amount_paisa: BigInt(amount),
    method: 'cash',
    purpose: 'dues',
    paid_at: `${paidOn}T12:00:00+06:00`,
    ...(note ? { note } : {}),
  }, ctx);

const submit = (code: FixtureCode, amount: string, paidOn: string) =>
  submitPayment(deps, user(code), {
    amount_paisa: BigInt(amount),
    method: 'cash',
    purpose: 'dues',
    paid_at: `${paidOn}T12:00:00+06:00`,
  }, ctx);

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  fund = await seedFund(db.admin);
  const silent = pino({ level: 'silent' });
  deps = { pool: db.app, clock, log: silent, pushSender: new ConsolePushSender(silent), smsProvider: new ConsoleSmsProvider(silent) };
  await generateDues({ pool: db.app, clock }, { period: '2026-11' });
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

describe('lastFineRun', () => {
  it('is this month\'s fine day once it has come, else last month\'s', () => {
    expect(lastFineRun('2026-11-21', 21)).toBe('2026-11-21');
    expect(lastFineRun('2026-11-30', 21)).toBe('2026-11-21');
    expect(lastFineRun('2026-11-20', 21)).toBe('2026-10-21');
    expect(lastFineRun('2027-01-05', 21)).toBe('2026-12-21');
  });
});

describe('late fine when the money arrived on time but was recorded later (ASSUMPTIONS 130)', () => {
  dbIt('follows the day the money arrived, not the day it was entered', async () => {
    // M03 (1 share) and M04 (1 share) tell the app on the 20th; nobody has confirmed by the 21st.
    at('2026-11-20T18:00:00');
    const m3 = await submit('M03', '500000', '2026-11-20');
    const m4 = await submit('M04', '500000', '2026-11-20');
    // M08 (4 shares) tells the app only on the 22nd that it paid on the 20th: recorded too late.
    // M05 (3 shares), M06 (1 share) and M02 (4 shares) pay the cashier; nothing is entered by the 21st.

    at('2026-11-21T00:05:00');
    await applyFines({ pool: db!.app, clock });
    // the job waits for the two payments sent in time
    expect((await november('M03')).fine).toBeUndefined();
    expect((await november('M04')).fine).toBeUndefined();
    for (const code of ['M05', 'M06', 'M02', 'M08'] as const) expect((await november(code)).fine).toBeDefined();
    const fineM05 = (await november('M05')).fine!;
    expect(fineM05.amount).toBe('150000'); // 3 shares x 500 BDT

    // 1. sent on the 20th, accepted on the 21st: no fine, the month is paid on time
    at('2026-11-21T10:00:00');
    await confirmPayment(deps, user('M01'), m3.id, {}, ctx);
    expect(await november('M03')).toMatchObject({ due: { status: 'paid' }, fine: undefined });

    // 2. sent on the 20th, rejected on the 22nd (the money never came): the fine follows at once
    at('2026-11-22T10:00:00');
    await rejectPayment(deps, user('M01'), m4.id, { reason: 'No such transfer' }, ctx);
    expect((await november('M04')).fine).toMatchObject({ amount: '50000', outstanding: '50000', cancelled: false });

    // 3. cash on the 20th, entered on the 21st with that date: a reason is required, then the fine goes
    at('2026-11-21T11:00:00');
    await expect(entry('M05', '1500000', '2026-11-20')).rejects.toMatchObject({ code: 'payment.backdate_reason_required' });
    expect((await november('M05')).due.status).toBe('overdue'); // nothing was saved
    const paid = await entry('M05', '1500000', '2026-11-20', 'Cash taken on the 20th, entered next day');
    expect(paid.cancelled_fine_ids).toEqual([fineM05.fine_id]);
    expect(paid.allocation.fine_paisa).toBe('0');
    expect(await november('M05')).toMatchObject({
      due: { status: 'paid' },
      fine: { fine_id: fineM05.fine_id, outstanding: '0', cancelled: true },
    });
    const fines = await q(`SELECT status FROM (SELECT f.id, CASE WHEN s.cancelled THEN 'cancelled' END AS status
                           FROM fines f JOIN v_fine_status s ON s.fine_id = f.id WHERE f.id = $1) x`, [fineM05.fine_id]);
    expect(fines[0]).toMatchObject({ status: 'cancelled' });
    expect(await q(`SELECT 1 FROM notifications WHERE member_id = $1 AND template = 'fine_cancelled'`, [fund.members.M05])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'fine.cancel' AND entity_id = $1`, [paid.id])).toHaveLength(1);

    // the auditor's list shows it with the cashier's reason
    const list = await listFineCancellations(db!.app, { limit: 50 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      member_code: 'M05', period: '2026-11', paid_on: '2026-11-20', recorded_on: '2026-11-21',
      reason: 'Cash taken on the 20th, entered next day', amount_paisa: '150000', in_force: true, cancelled_by_code: 'M01',
    });

    // 4. paid on the 22nd: late, the fine stays
    at('2026-11-22T12:00:00');
    const late = await entry('M06', '500000', '2026-11-22');
    expect(late.cancelled_fine_ids).toBeUndefined();
    expect(await november('M06')).toMatchObject({ due: { status: 'paid_late' }, fine: { outstanding: '50000', cancelled: false } });

    // 5. part of the month on the 20th, entered with a reason: the month is still unpaid, the fine stays
    const part = await entry('M02', '1000000', '2026-11-20', 'SMS came late');
    expect(part.cancelled_fine_ids).toBeUndefined();
    expect((await november('M02')).fine).toMatchObject({ outstanding: '200000', cancelled: false });

    // 6. the member says "paid on the 20th" but only tells the app on the 22nd: counts from the 22nd
    const m8 = await submit('M08', '2000000', '2026-11-20');
    await confirmPayment(deps, user('M01'), m8.id, {}, ctx);
    expect((await november('M08')).fine).toMatchObject({ outstanding: '200000', cancelled: false });

    // reversing the payment that proved the fine wrong makes the fine owed again
    const { approval_id } = await requestReversal(deps, user('M01'), paid.id, 'Entered for the wrong member', ctx);
    await approveApproval(deps, user('M07'), approval_id, undefined, ctx);
    expect(await november('M05')).toMatchObject({ due: { status: 'overdue' }, fine: { outstanding: '150000', cancelled: false } });
    expect((await listFineCancellations(db!.app, { limit: 50 })).items[0]).toMatchObject({ in_force: false });

    // a reversed on-time payment that the job had waited for: the due is fined as the last run would have
    const { approval_id: a3 } = await requestReversal(deps, user('M01'), m3.id, 'Bounced', ctx);
    await approveApproval(deps, user('M07'), a3, undefined, ctx);
    expect((await november('M03')).fine).toMatchObject({ outstanding: '50000' });

    // the job running again changes nothing: one fine per due
    expect(await applyFines({ pool: db!.app, clock }, '2026-12-21')).toHaveLength(0);
  });
});
