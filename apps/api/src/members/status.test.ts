import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock } from '@barakah/shared';
import { statusJob } from '../jobs/workers/status';
import { createLogger } from '../lib/logger';
import { inTransaction } from '../lib/tx';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, testEnv, type Fund } from '../test/fund-fixture';
import type { PushResult, PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import { computeConsecutiveUnpaidMonths, computeMemberFinancials } from './status';
import { computeSettlementQuote, estimateSettlement, executeSettlement } from './settlement';

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
    send: async (tokens: string[], title: string | undefined, body: string): Promise<PushResult[]> => {
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

async function setupMemberArrears(
  db: TestDb,
  memberId: string,
  periods: string[],
  fineAmount = 1_000,
) {
  for (const period of periods) {
    await db.admin.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [period]);
    const dueDate = `${period}-20`;
    await db.admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, $2, 'monthly', 1, 1500, $3::date)
       ON CONFLICT DO NOTHING`,
      [memberId, period, dueDate],
    );
  }
  const dueRows = (await db.admin.query(
    `SELECT id FROM dues WHERE member_id = $1 AND period = $2 AND kind = 'monthly'`,
    [memberId, periods[0]],
  )).rows as Array<{ id: string }>;
  if (dueRows[0] && fineAmount > 0) {
    await db.admin.query(
      `INSERT INTO fines (due_id, member_id, amount_paisa, kind, reason)
       VALUES ($1, $2, $3, 'late_payment', 'test fine')`,
      [dueRows[0]!.id, memberId, fineAmount],
    );
  }
}

function makeDeps(db: TestDb, clock: ReturnType<typeof createFakeClock>, pushCalls: PushCall[], smsCalls: SmsCall[]) {
  return {
    pool: db.app,
    clock,
    log: createLogger('silent'),
    pushSender: fakePushSender(pushCalls),
    smsProvider: fakeSmsProvider(smsCalls),
  };
}

describe('member status machine', () => {
  let db: TestDb | null = null;
  let fund: Fund;
  const clock = createFakeClock(new Date('2026-12-25T10:00:00Z'));

  beforeAll(async () => {
    db = await createTestDb();
    if (db) fund = await seedFund(db.admin);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  function test(name: string, fn: () => Promise<void>) {
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });
  }

  test('computeConsecutiveUnpaidMonths counts consecutive months with unpaid dues or fines', async () => {
    const m = fund.members.M03;

    // No arrears.
    expect(await computeConsecutiveUnpaidMonths(db!.app, m, clock.todayDhaka())).toBe(0);

    await setupMemberArrears(db!, m, ['2026-11', '2026-12'], 0);
    // Two consecutive months with outstanding dues.
    expect(await computeConsecutiveUnpaidMonths(db!.app, m, clock.todayDhaka())).toBe(2);

    // A payment that clears November removes the streak back to December only.
    const p = (
      await db!.admin.query(
        `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, unallocated_paisa, confirmed_at)
         VALUES ($1, 1500, 'cash', now(), 'confirmed', 'cashier_entry', 0, now())
         RETURNING id`,
        [m],
      )
    ).rows[0] as { id: string };
    const novDue = (await db!.admin.query(
      `SELECT id FROM dues WHERE member_id = $1 AND period = '2026-11' AND kind = 'monthly'`,
      [m],
    )).rows[0] as { id: string };
    await db!.admin.query(
      `INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1,$2,1500)`,
      [p.id, novDue.id],
    );
    await db!.admin.query(`UPDATE payments SET unallocated_paisa = 0 WHERE id = $1`, [p.id]);

    expect(await computeConsecutiveUnpaidMonths(db!.app, m, clock.todayDhaka())).toBe(1);
  });

  test('warning transition after configured consecutive unpaid months', async () => {
    const m = fund.members.M04;
    const pushCalls: PushCall[] = [];
    const smsCalls: SmsCall[] = [];
    const deps = makeDeps(db!, clock, pushCalls, smsCalls);

    await db!.admin.query(`UPDATE members SET status = 'active' WHERE id = $1`, [m]);
    await setupMemberArrears(db!, m, ['2026-11', '2026-12']);

    await statusJob({ ...deps, env: testEnv } as unknown as Parameters<typeof statusJob>[0]);

    const status = (await db!.admin.query(`SELECT status FROM members WHERE id = $1`, [m])).rows[0] as {
      status: string;
    };
    expect(status.status).toBe('warning');

    const events = (await db!.admin.query(
      `SELECT to_status FROM member_status_events WHERE member_id = $1 ORDER BY created_at`,
      [m],
    )).rows as Array<{ to_status: string }>;
    expect(events.map((e) => e.to_status)).toEqual(['warning']);
  });

  test('final notice is queued for a warning member with three consecutive unpaid months', async () => {
    const m = fund.members.M05;
    const pushCalls: PushCall[] = [];
    const smsCalls: SmsCall[] = [];
    const deps = makeDeps(db!, clock, pushCalls, smsCalls);

    await db!.admin.query(`UPDATE members SET status = 'warning' WHERE id = $1`, [m]);
    await db!.admin.query(`DELETE FROM notifications WHERE member_id = $1`, [m]);
    await setupMemberArrears(db!, m, ['2026-10', '2026-11', '2026-12']);

    await statusJob({ ...deps, env: testEnv } as unknown as Parameters<typeof statusJob>[0]);

    const notices = (await db!.admin.query(
      `SELECT channel, status FROM notifications WHERE member_id = $1 AND template = 'final_notice'`,
      [m],
    )).rows as Array<{ channel: string; status: string }>;

    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.channel).sort()).toEqual(['push', 'sms']);
  });

  test('auto-suspension runs after final_notice_days when auto_suspend is true', async () => {
    const m = fund.members.M06;
    const pushCalls: PushCall[] = [];
    const smsCalls: SmsCall[] = [];
    const deps = makeDeps(db!, clock, pushCalls, smsCalls);

    await db!.admin.query(`UPDATE members SET status = 'warning' WHERE id = $1`, [m]);
    await db!.admin.query(`DELETE FROM notifications WHERE member_id = $1`, [m]);
    await db!.admin.query(`DELETE FROM member_status_events WHERE member_id = $1`, [m]);
    await setupMemberArrears(db!, m, ['2026-10', '2026-11', '2026-12']);

    // Run today: this queues the final notice.
    await statusJob({ ...deps, env: testEnv } as unknown as Parameters<typeof statusJob>[0]);
    let status = (await db!.admin.query(`SELECT status FROM members WHERE id = $1`, [m])).rows[0] as {
      status: string;
    };
    expect(status.status).toBe('warning');

    // Move past the final-notice window (7 days) while arrears remain.
    clock.set(new Date('2027-01-08T10:00:00Z'));
    await statusJob({ ...deps, env: testEnv } as unknown as Parameters<typeof statusJob>[0]);

    status = (await db!.admin.query(`SELECT status FROM members WHERE id = $1`, [m])).rows[0] as {
      status: string;
    };
    expect(status.status).toBe('suspended');

    const event = (await db!.admin.query(
      `SELECT to_status, proposal_id FROM member_status_events WHERE member_id = $1 AND to_status = 'suspended'`,
      [m],
    )).rows[0] as { to_status: string; proposal_id: string };
    expect(event).toBeTruthy();

    const proposal = (await db!.admin.query(
      `SELECT status, type, subject_member_id FROM proposals WHERE id = $1`,
      [event.proposal_id],
    )).rows[0] as { status: string; type: string; subject_member_id: string };
    expect(proposal).toMatchObject({
      status: 'executed',
      type: 'suspension',
      subject_member_id: m,
    });
  });
});

describe('settlement NAV invariant', () => {
  let db: TestDb | null = null;
  let fund: Fund;
  const clock = createFakeClock(new Date('2026-11-15T10:00:00Z'));

  beforeAll(async () => {
    db = await createTestDb();
    if (db) fund = await seedFund(db.admin);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  function test(name: string, fn: () => Promise<void>) {
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });
  }

  test('NAV per share changes by the expected deduction per remaining share', async () => {
    const m = fund.members.M02;
    const pushCalls: PushCall[] = [];
    const smsCalls: SmsCall[] = [];

    // Give the fund cash and M02 paid-in capital via a confirmed deposit.
    await db!.admin.query(
      `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id)
       VALUES ('2026-11-10', 'BANK', 'MEMBER_CAPITAL', 50000, $1, 'payment', gen_random_uuid())`,
      [m],
    );

    // Create one unpaid due and fine for M02 to act as settlement deductions. The due date is already
    // past: a due that is not due yet is not deducted from a settlement.
    await db!.admin.query(`INSERT INTO periods (period) VALUES ('2026-11') ON CONFLICT DO NOTHING`);
    const dueRes = await db!.admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, '2026-11', 'monthly', 1, 3000, '2026-11-10')
       RETURNING id`,
      [m],
    );
    const dueId = (dueRes.rows[0] as { id: string }).id;
    await db!.admin.query(
      `INSERT INTO fines (due_id, member_id, amount_paisa, kind, reason)
       VALUES ($1, $2, 1000, 'late_payment', 'test')`,
      [dueId, m],
    );

    // Create a placeholder settlement proposal so the non-null settlement.proposal_id is satisfied.
    const proposalRes = await db!.admin.query(
      `INSERT INTO proposals (type, title, subject_member_id, payload, created_by, status)
       VALUES ('settlement', 'Test settlement', $1, '{}', $2, 'executed')
       RETURNING id`,
      [m, fund.users.M01],
    );
    const proposalId = (proposalRes.rows[0] as { id: string }).id;

    const before = await computeMemberFinancials(db!.app, m, clock.todayDhaka());
    const navBefore = before.navPerShare;
    const sharesBefore = before.sharesOutstanding;
    const memberShares = before.shares;
    const gross = (BigInt(memberShares) * before.netAssets) / BigInt(sharesBefore);
    const deductions = 3000n + 1000n;
    const net = gross - deductions; // escrow is zero

    const quote = await inTransaction(db!.app, async (tx) =>
      computeSettlementQuote(
        tx,
        {
          pool: db!.app,
          clock,
          pushSender: fakePushSender(pushCalls),
          smsProvider: fakeSmsProvider(smsCalls),
          log: createLogger('silent'),
        },
        m,
        {
          kind: 'death_surrender',
          payout_plan: [{ due_on: clock.todayDhaka(), amount_paisa: net }],
          proposal_id: proposalId,
        },
      ),
    );
    expect(quote.net).toBe(net);
    expect(quote.deductions.total).toBe(deductions);

    await inTransaction(db!.app, async (tx) =>
      executeSettlement(
        tx,
        {
          pool: db!.app,
          clock,
          pushSender: fakePushSender(pushCalls),
          smsProvider: fakeSmsProvider(smsCalls),
          log: createLogger('silent'),
        },
        quote.settlement_id,
        { userId: fund.users.M01, ip: undefined, deviceId: null },
      ),
    );

    const after = await computeMemberFinancials(db!.app, m, clock.todayDhaka());
    const navAfter = after.navPerShare;
    const sharesAfter = after.sharesOutstanding;

    // Invariant from 5.10: NAV_after = NAV_before + deductions / shares_after.
    const { divRound } = await import('@barakah/shared');
    const expected = navBefore + divRound(deductions, BigInt(sharesAfter));
    expect(Math.abs(Number(navAfter - expected))).toBeLessThanOrEqual(1);
  });

  test('the early-exit estimate keeps 10% of the paid-in money and skips a due that is not due yet', async () => {
    const m = fund.members.M04;
    await db!.admin.query(
      `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id)
       VALUES ('2026-11-10', 'BANK', 'MEMBER_CAPITAL', 100000, $1, 'payment', gen_random_uuid())`,
      [m],
    );
    // A due for December exists already, but its date (the clock says 15 November) has not come.
    await db!.admin.query(`INSERT INTO periods (period) VALUES ('2026-12') ON CONFLICT DO NOTHING`);
    await db!.admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, '2026-12', 'monthly', 1, 7000, '2026-12-10')`,
      [m],
    );
    const est = await estimateSettlement(db!.app, clock, m, 'early_exit');
    expect(est.gross_paisa).toBe('100000');
    expect(est.exit_fee_paisa).toBe('10000');
    expect(est.principal_paisa).toBe('0');
    expect(BigInt(est.net_paisa)).toBe(100000n - 10000n - BigInt(est.fines_paisa) + BigInt(est.escrow_paisa));
    // Compassionate exit keeps nothing back.
    expect((await estimateSettlement(db!.app, clock, m, 'compassionate_exit')).exit_fee_paisa).toBe('0');
  });

  test('executing an early-exit settlement pays the 10% charge and the unpaid fines to charity', async () => {
    const m = fund.members.M07;
    await db!.admin.query(
      `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id)
       VALUES ('2026-11-10', 'BANK', 'MEMBER_CAPITAL', 100000, $1, 'payment', gen_random_uuid())`,
      [m],
    );
    await db!.admin.query(`INSERT INTO periods (period) VALUES ('2026-11') ON CONFLICT DO NOTHING`);
    const due = (await db!.admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, '2026-11', 'monthly', 1, 3000, '2026-11-10') RETURNING id`,
      [m],
    )).rows[0] as { id: string };
    await db!.admin.query(
      `INSERT INTO fines (due_id, member_id, amount_paisa, kind, reason) VALUES ($1, $2, 1000, 'late_payment', 'test')`,
      [due.id, m],
    );
    // December's due is already made but dated after the exit: the settlement must close it.
    await db!.admin.query(`INSERT INTO periods (period) VALUES ('2026-12') ON CONFLICT DO NOTHING`);
    await db!.admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, '2026-12', 'monthly', 1, 3000, '2026-12-10')`,
      [m],
    );
    const proposalId = ((await db!.admin.query(
      `INSERT INTO proposals (type, title, subject_member_id, payload, created_by, status)
       VALUES ('settlement', 'Exit', $1, '{}', $2, 'approved') RETURNING id`,
      [m, fund.users.M01],
    )).rows[0] as { id: string }).id;

    const est = await estimateSettlement(db!.app, clock, m, 'early_exit');
    const charity = async () =>
      BigInt(((await db!.admin.query(`SELECT natural_balance_paisa AS b FROM v_account_balances WHERE code = 'CHARITY_PAYABLE'`)).rows[0] as { b: string } | undefined)?.b ?? 0);
    const before = await charity();

    const { settlementExecutor } = await import('../proposals/executors/membership');
    await inTransaction(db!.app, (tx) =>
      settlementExecutor(
        tx,
        { id: proposalId, payload: { member_id: m, kind: 'early_exit', payout_plan: [{ due_on: '2026-11-15', amount_paisa: est.net_paisa }] } } as never,
        {} as never,
        { id: fund.users.M01, device_id: 'test' } as never,
        { ip: '127.0.0.1' } as never,
        { clock } as never,
      ),
    );

    // The charge (10% of 100,000) and the 1,000 fine both reached the charity fund.
    expect(est.exit_fee_paisa).toBe('10000');
    expect((await charity()) - before).toBe(10000n + 1000n);
    // The fine is closed, and nothing is booked to fund income for the exit.
    const fine = (await db!.admin.query(`SELECT outstanding_paisa FROM v_fine_status WHERE member_id = $1`, [m])).rows as Array<{ outstanding_paisa: string }>;
    expect(fine.every((f) => f.outstanding_paisa === '0')).toBe(true);
    const income = await db!.admin.query(`SELECT 1 FROM ledger_entries WHERE ref_id = $1 AND credit_account = 'EXIT_FEE_INCOME'`, [proposalId]);
    expect(income.rows).toHaveLength(0);
    // Nothing dated after the exit is left to turn overdue later.
    const later = await db!.admin.query(`SELECT 1 FROM v_due_status WHERE member_id = $1 AND due_date > '2026-11-15' AND outstanding_paisa > 0`, [m]);
    expect(later.rows).toHaveLength(0);
  });

  test('a member who left can join again on the same phone number, but not on a current member number', async () => {
    const { ensurePhoneFree } = await import('./entry');
    const current = (await db!.admin.query(`SELECT phone FROM members WHERE id = $1`, [fund.members.M02])).rows[0] as { phone: string };
    await expect(ensurePhoneFree(db!.app, current.phone)).rejects.toMatchObject({ code: 'member.phone_taken' });

    const left = (await db!.admin.query(
      `UPDATE members SET status = 'exited', exited_on = '2026-11-15' WHERE id = $1 RETURNING phone`,
      [fund.members.M04],
    )).rows[0] as { phone: string };
    await expect(ensurePhoneFree(db!.app, left.phone)).resolves.toBeUndefined();
    await db!.admin.query(
      `INSERT INTO members (code, full_name, phone, status, joined_on) VALUES ('M90', 'Back again', $1, 'prospective', '2026-11-15')`,
      [left.phone],
    );
    // A second current member on that number is still refused by the database itself.
    await expect(db!.admin.query(
      `INSERT INTO members (code, full_name, phone, status, joined_on) VALUES ('M91', 'Twin', $1, 'prospective', '2026-11-15')`,
      [left.phone],
    )).rejects.toThrow(/members_phone_current/);
  });
});
