import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createFakeClock } from '@barakah/shared';
import pino from 'pino';
import { ConsolePushSender } from '../notifications/providers/push';
import { ConsoleSmsProvider } from '../notifications/providers/sms';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import { cashierEntry } from '../payments/service';
import { computeNav } from '../lib/nav';
import { createEntryQuoteFromProposal, activateProspectiveMember, currentEntryQuote, requoteEntry, type EntryDeps } from './entry';
import { generateDues } from '../dues/service';

describe('new member entry quote', () => {
  let db: TestDb | null = null;
  let fund: Fund;
  let deps: EntryDeps;
  const clock = createFakeClock(new Date('2026-05-10T06:00:00Z'));

  function authUser(code: 'M01'): {
    id: string;
    member_id: string;
    member_code: string;
    full_name: string;
    roles: ('member' | 'cashier' | 'auditor')[];
    user_status: 'active';
    member_status: string;
    totp_enabled: boolean;
    device_id: string;
    step_up_at: Date | null;
  } {
    return {
      id: fund.users[code],
      member_id: fund.members[code],
      member_code: code,
      full_name: 'Test User',
      roles: code === 'M01' ? ['member', 'cashier'] : ['member'],
      user_status: 'active',
      member_status: 'active',
      totp_enabled: false,
      device_id: '11111111-1111-1111-1111-111111111111',
      step_up_at: null,
    };
  }

  async function one<T>(client: pg.Pool | pg.PoolClient, sql: string, params: unknown[]): Promise<T> {
    const res = await client.query(sql, params);
    return res.rows[0] as T;
  }

  async function newMemberProposal(admin: pg.Pool, payload: object): Promise<string> {
    const res = await admin.query(
      `INSERT INTO proposals (type, title, payload, created_by)
       VALUES ('new_member', 'New member', $1::jsonb, $2)
       RETURNING id`,
      [JSON.stringify(payload), fund.users.M01],
    );
    return (res.rows[0] as { id: string }).id;
  }

  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    fund = await seedFund(db.admin);
    deps = {
      pool: db.app,
      clock,
      log: pino({ level: 'silent' }),
      pushSender: new ConsolePushSender(pino({ level: 'silent' })),
      smsProvider: new ConsoleSmsProvider(pino({ level: 'silent' })),
    };

    // Put capital and cash into the fund so NAV is non-zero for the test.
    await generateDues({ pool: db.app, clock }, { period: '2026-05' });
    const actor = authUser('M01');
    const memberId = fund.members.M01;
    const row = await one<{ shares: number }>(
      db.admin,
      `SELECT shares_on($1::uuid, $2::date) AS shares`,
      [memberId, clock.todayDhaka()],
    );
    const amount = BigInt(row.shares) * 500000n;
    await cashierEntry(
      { pool: db.app, clock, log: deps.log, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
      actor,
      {
        member_id: memberId,
        amount_paisa: amount,
        method: 'bkash',
        purpose: 'dues',
        paid_at: clock.now().toISOString(),
        trx_id: 'DUEQUOTE001',
        note: 'seed for entry quote test',
      },
      { ip: '127.0.0.1' },
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  dbIt('entry price leaves NAV per share unchanged for existing members within 1 paisa', async () => {
    const navBefore = await computeNav(db!.app, clock.todayDhaka());
    expect(navBefore.shares_outstanding).toBeGreaterThan(0);

    const proposalId = await newMemberProposal(db!.admin, {
      name: 'New Member',
      phone: '+8801700000099',
      shares: 2,
    });

    const quote = await createEntryQuoteFromProposal(db!.app, deps, proposalId);
    expect(quote.shares).toBe(2);
    expect(quote.price_paisa).toBeGreaterThan(0n);

    const entryDue = await one<{ id: string; amount_paisa: string }>(
      db!.admin,
      `SELECT id, amount_paisa::text FROM dues WHERE member_id = $1 AND kind = 'entry'`,
      [quote.member_id],
    );
    expect(BigInt(entryDue.amount_paisa)).toBe(quote.price_paisa);

    // Pay the entry due in full.
    await cashierEntry(
      { pool: db!.app, clock, log: deps.log, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
      authUser('M01'),
      {
        member_id: quote.member_id,
        amount_paisa: quote.price_paisa,
        method: 'bank',
        purpose: 'entry',
        paid_at: clock.now().toISOString(),
        trx_id: 'ENTRYPAY001',
        note: 'entry payment',
      },
      { ip: '127.0.0.1' },
    );

    // Activation inserts holdings effective tomorrow; measure NAV then.
    const tomorrow = '2026-05-11';
    const navAfter = await computeNav(db!.app, tomorrow);
    expect(navAfter.shares_outstanding).toBe(navBefore.shares_outstanding + 2);

    // Rounding can shift NAV/share by at most 1 paisa.
    expect(Number(navAfter.nav_per_share - navBefore.nav_per_share)).toBeLessThanOrEqual(1);
    expect(Number(navBefore.nav_per_share - navAfter.nav_per_share)).toBeLessThanOrEqual(1);

    const member = await one<{ status: string; code: string }>(
      db!.admin,
      `SELECT status, code FROM members WHERE id = $1`,
      [quote.member_id],
    );
    expect(member.status).toBe('active');

    const user = await one<{ id: string } | null>(
      db!.admin,
      `SELECT id FROM users WHERE member_id = $1`,
      [quote.member_id],
    );
    expect(user).not.toBeNull();
  });

  dbIt('activateProspectiveMember is idempotent', async () => {
    const proposalId = await newMemberProposal(db!.admin, {
      name: 'Idempotent Member',
      phone: '+8801700000088',
      shares: 1,
    });
    const quote = await createEntryQuoteFromProposal(db!.app, deps, proposalId);
    await cashierEntry(
      { pool: db!.app, clock, log: deps.log, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
      authUser('M01'),
      {
        member_id: quote.member_id,
        amount_paisa: quote.price_paisa,
        method: 'cash',
        purpose: 'entry',
        paid_at: clock.now().toISOString(),
        trx_id: 'ENTRYPAY002',
      },
      { ip: '127.0.0.1' },
    );

    const first = await activateProspectiveMember(db!.app, deps, quote.member_id);
    const second = await activateProspectiveMember(db!.app, deps, quote.member_id);
    expect(first.user_id).toBe(second.user_id);
  });

  dbIt('a lapsed quote refuses payment until a new quote is made; money already paid counts', async () => {
    const payDeps = () => ({ pool: db!.app, clock, log: deps.log, pushSender: deps.pushSender, smsProvider: deps.smsProvider });
    const pay = (memberId: string, amount: bigint, trx: string) =>
      cashierEntry(payDeps(), authUser('M01'), {
        member_id: memberId, amount_paisa: amount, method: 'bank', purpose: 'entry', paid_at: clock.now().toISOString(), trx_id: trx,
      }, { ip: '127.0.0.1' });

    const proposalId = await newMemberProposal(db!.admin, { name: 'Late Member', phone: '+8801700000077', shares: 1 });
    const quote = await createEntryQuoteFromProposal(db!.app, deps, proposalId);
    const part = quote.price_paisa / 3n;
    await pay(quote.member_id, part, 'ENTRYPART01'); // within the 7 days

    // a quote cannot be replaced while it is still valid
    await expect(requoteEntry(db!.app, deps, fund.users.M01, quote.member_id)).rejects.toMatchObject({ code: 'entry.quote_still_valid' });

    clock.advance(8 * 24 * 60 * 60 * 1000);
    expect((await currentEntryQuote(db!.app, clock, quote.member_id))?.expired).toBe(true);
    await expect(pay(quote.member_id, quote.price_paisa - part, 'ENTRYLATE01')).rejects.toMatchObject({ code: 'entry.quote_expired' });

    const navBefore = await computeNav(db!.app, clock.todayDhaka());
    const fresh = await requoteEntry(db!.app, deps, fund.users.M01, quote.member_id);
    expect(fresh.expired).toBe(false);
    expect(fresh.paid_paisa).toBe(part.toString());
    expect(BigInt(fresh.outstanding_paisa)).toBe(BigInt(fresh.price_paisa) - part);
    // the member's own part payment is not priced into the share they are buying
    const expected = ((navBefore.net_assets_paisa - part) * 2n + BigInt(navBefore.shares_outstanding)) / (2n * BigInt(navBefore.shares_outstanding));
    expect(BigInt(fresh.price_paisa) - expected).toBeLessThanOrEqual(1n);

    // the old due owes nothing more; only the new one is open
    const open = await db!.admin.query(
      `SELECT outstanding_paisa::text AS o FROM v_due_status WHERE member_id = $1 AND kind = 'entry' ORDER BY outstanding_paisa`,
      [quote.member_id],
    );
    expect(open.rows.map((r) => (r as { o: string }).o)).toEqual(['0', fresh.outstanding_paisa]);

    await pay(quote.member_id, BigInt(fresh.outstanding_paisa), 'ENTRYREST01');
    const member = await one<{ status: string }>(db!.admin, `SELECT status FROM members WHERE id = $1`, [quote.member_id]);
    expect(member.status).toBe('active');
    const owed = await one<{ o: string }>(
      db!.admin,
      `SELECT COALESCE(SUM(outstanding_paisa), 0)::text AS o FROM v_due_status WHERE member_id = $1`,
      [quote.member_id],
    );
    expect(owed.o).toBe('0');
  });
});
