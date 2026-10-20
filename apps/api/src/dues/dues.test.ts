import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock, type Clock } from '@barakah/shared';
import { AppError } from '../lib/errors';
import {
  fundTerm,
  getRule,
  listRuleHistory,
  listRulesInForce,
  rulePaisa,
  ruleInt,
} from '../lib/rules';
import { createTestDb, type TestDb } from '../test/db-harness';
import { addConfirmedPayment, seedFund, type Fund } from '../test/fund-fixture';
import { generateDues } from './service';

/** 2026-11-05 09:00 in Dhaka. */
const NOV_5 = new Date('2026-11-05T03:00:00Z');

/** Each describe gets its own database: dues are append-only, so state cannot be reset in place. */
function useFund(clock: Clock) {
  const ctx = {} as { db: TestDb; fund: Fund; deps: { pool: TestDb['app']; clock: Clock } };
  let skip = false;
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) {
      skip = true;
      return;
    }
    ctx.db = db;
    ctx.fund = await seedFund(db.admin);
    ctx.deps = { pool: db.app, clock };
  }, 120_000);
  afterAll(async () => {
    await ctx.db?.close();
  });
  return {
    ctx,
    test(name: string, fn: () => Promise<void>) {
      it(name, async (t) => {
        if (skip) return t.skip();
        await fn();
      });
    },
  };
}

const dueRows = async (db: TestDb, period: string) =>
  (
    await db.admin.query(
      `SELECT m.code, d.kind, d.shares_snapshot, d.amount_paisa::text AS amount, d.due_date::text AS due_date
       FROM dues d JOIN members m ON m.id = d.member_id WHERE d.period = $1 ORDER BY m.code, d.kind`,
      [period],
    )
  ).rows as Array<{
    code: string;
    kind: string;
    shares_snapshot: number;
    amount: string;
    due_date: string;
  }>;

describe('generateDues: amounts, due dates, idempotency', () => {
  const clock = createFakeClock(NOV_5);
  const { ctx, test } = useFund(clock);

  test('creates one monthly due per member: shares x monthly_due_per_share_paisa', async () => {
    const result = await generateDues(ctx.deps, { period: '2026-11' });
    expect(result.skipped).toBeNull();
    expect(result.created).toHaveLength(8);

    const rows = await dueRows(ctx.db, '2026-11');
    expect(rows.map((r) => [r.code, r.kind, r.shares_snapshot, r.amount])).toEqual([
      ['M01', 'monthly', 2, '1000000'],
      ['M02', 'monthly', 4, '2000000'],
      ['M03', 'monthly', 1, '500000'],
      ['M04', 'monthly', 1, '500000'],
      ['M05', 'monthly', 3, '1500000'],
      ['M06', 'monthly', 1, '500000'],
      ['M07', 'monthly', 4, '2000000'],
      ['M08', 'monthly', 4, '2000000'],
    ]);
    // 20 shares x 5,000 BDT.
    expect(rows.reduce((sum, r) => sum + BigInt(r.amount), 0n)).toBe(10_000_000n);
  });

  test('the due date is the due_day of the period, as a plain date string', async () => {
    const rows = await dueRows(ctx.db, '2026-11');
    expect(new Set(rows.map((r) => r.due_date))).toEqual(new Set(['2026-11-20']));
  });

  test('is idempotent: a second run creates nothing and writes no second audit row', async () => {
    const again = await generateDues(ctx.deps, { period: '2026-11' });
    expect(again.created).toHaveLength(0);
    expect(again.already_existed).toBe(8);
    expect(await dueRows(ctx.db, '2026-11')).toHaveLength(8);

    const audit = await ctx.db.admin.query(
      `SELECT after FROM audit_log WHERE action = 'dues.generate' AND entity_id = '2026-11'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({ after: { created: 8, kinds: ['monthly'] } });
  });

  test('records the period so it can later be reconciled and locked', async () => {
    const res = await ctx.db.admin.query(`SELECT locked_at FROM periods WHERE period = '2026-11'`);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toMatchObject({ locked_at: null });
  });

  test('creates no ledger entries: a due is a receivable, not a posting', async () => {
    const res = await ctx.db.admin.query(`SELECT count(*)::int AS n FROM ledger_entries`);
    expect(res.rows[0]).toMatchObject({ n: 0 });
  });

  test('backfills a past period', async () => {
    const result = await generateDues(ctx.deps, { period: '2026-03' });
    expect(result.created).toHaveLength(8);
    expect((await dueRows(ctx.db, '2026-03'))[0]).toMatchObject({ due_date: '2026-03-20' });
  });

  test('rejects a malformed period', async () => {
    await expect(generateDues(ctx.deps, { period: '2026-13' })).rejects.toMatchObject({
      code: 'dues.invalid_period',
    });
  });
});

describe('generateDues: periods are judged in Asia/Dhaka', () => {
  const clock = createFakeClock(new Date('2026-11-30T17:00:00Z')); // 30 Nov 23:00 in Dhaka
  const { ctx, test } = useFund(clock);

  test('December is still the future at 23:00 on 30 November in Dhaka', async () => {
    await expect(generateDues(ctx.deps, { period: '2026-12' })).rejects.toMatchObject({
      status: 400,
      code: 'dues.period_in_future',
    });
  });

  test('two hours later it is 1 December in Dhaka (still 30 Nov in UTC), so December is allowed', async () => {
    clock.set(new Date('2026-11-30T19:00:00Z')); // 01:00 on 1 Dec in Dhaka
    const result = await generateDues(ctx.deps, { period: '2026-12' });
    expect(result.created).toHaveLength(8);
    expect(result.created[0]?.due_date).toBe('2026-12-20');
    expect(await dueRows(ctx.db, '2026-12')).toHaveLength(8);
  });

  test('January is still in the future', async () => {
    await expect(generateDues(ctx.deps, { period: '2027-01' })).rejects.toBeInstanceOf(AppError);
  });
});

describe('generateDues: who gets a due and for how many shares', () => {
  const clock = createFakeClock(new Date('2027-03-05T03:00:00Z'));
  const { ctx, test } = useFund(clock);

  test('uses the shares held on the first day of the period', async () => {
    const m = ctx.fund.members;
    // M03 (1 share) buys 2 more, effective 10 December: December still bills 1 share, January 3.
    await ctx.db.admin.query(
      `INSERT INTO share_holdings (member_id, shares, effective_from, source)
       VALUES ($1, 2, '2026-12-10', 'transfer_in')`,
      [m.M03],
    );
    // M04 sells down: the holding ends 1 January, so January no longer counts it (end exclusive).
    await ctx.db.admin.query(
      `UPDATE share_holdings SET effective_to = '2027-01-01' WHERE member_id = $1`,
      [m.M04],
    );
    await ctx.db.admin.query(
      `INSERT INTO share_holdings (member_id, shares, effective_from, source)
       VALUES ($1, 3, '2027-01-01', 'transfer_in')`,
      [m.M04],
    );

    await generateDues(ctx.deps, { period: '2026-12' });
    await generateDues(ctx.deps, { period: '2027-01' });
    const dec = await dueRows(ctx.db, '2026-12');
    const jan = await dueRows(ctx.db, '2027-01');
    const pick = (rows: typeof dec, code: string) => rows.find((r) => r.code === code);
    expect(pick(dec, 'M03')).toMatchObject({ shares_snapshot: 1, amount: '500000' });
    expect(pick(jan, 'M03')).toMatchObject({ shares_snapshot: 3, amount: '1500000' });
    expect(pick(dec, 'M04')).toMatchObject({ shares_snapshot: 1, amount: '500000' });
    expect(pick(jan, 'M04')).toMatchObject({ shares_snapshot: 3, amount: '1500000' });
  });

  test('a new member whose shares start the day after joining is billed from the next period', async () => {
    const joined = await ctx.db.admin.query(
      `INSERT INTO members (code, full_name, phone, joined_on)
       VALUES ('M09', 'Member M09', '+8801700000009', '2027-02-01') RETURNING id`,
    );
    const id = (joined.rows[0] as { id: string }).id;
    await ctx.db.admin.query(
      `INSERT INTO share_holdings (member_id, shares, effective_from, source)
       VALUES ($1, 1, '2027-02-02', 'entry')`,
      [id],
    );
    await generateDues(ctx.deps, { period: '2027-02' });
    await generateDues(ctx.deps, { period: '2027-03' });
    expect((await dueRows(ctx.db, '2027-02')).find((r) => r.code === 'M09')).toBeUndefined();
    expect((await dueRows(ctx.db, '2027-03')).find((r) => r.code === 'M09')).toMatchObject({
      amount: '500000',
    });
  });

  test('suspended, exited, inactive, deceased and prospective members get no due; warning does', async () => {
    const m = ctx.fund.members;
    const statuses: Array<[keyof Fund['members'], string]> = [
      ['M02', 'suspended'],
      ['M05', 'exited'],
      ['M06', 'inactive'],
      ['M07', 'deceased'],
      ['M08', 'prospective'],
      ['M03', 'warning'],
    ];
    for (const [code, status] of statuses) {
      await ctx.db.admin.query(`UPDATE members SET status = $2 WHERE id = $1`, [m[code], status]);
    }
    await ctx.db.admin.query(
      `INSERT INTO periods (period) VALUES ('2026-06') ON CONFLICT DO NOTHING`,
    );
    await generateDues(ctx.deps, { period: '2026-06' });
    expect((await dueRows(ctx.db, '2026-06')).map((r) => r.code)).toEqual(['M01', 'M03', 'M04']);
  });
});

describe('generateDues: rules are read as of the period', () => {
  const clock = createFakeClock(new Date('2027-06-05T03:00:00Z'));
  const { ctx, test } = useFund(clock);

  test('a rule change affects only the periods that start on or after its valid_from', async () => {
    await ctx.db.admin.query(
      `INSERT INTO rules (key, value, valid_from, clause_ref) VALUES
         ('monthly_due_per_share_paisa', '600000', '2027-03-01', '1.4'),
         ('due_day', '25', '2027-04-01', '2.1')`,
    );
    for (const period of ['2027-02', '2027-03', '2027-04'])
      await generateDues(ctx.deps, { period });

    const m03 = async (period: string) =>
      (await dueRows(ctx.db, period)).find((r) => r.code === 'M03');
    expect(await m03('2027-02')).toMatchObject({ amount: '500000', due_date: '2027-02-20' });
    expect(await m03('2027-03')).toMatchObject({ amount: '600000', due_date: '2027-03-20' });
    expect(await m03('2027-04')).toMatchObject({ amount: '600000', due_date: '2027-04-25' });
  });

  test('a rule that starts mid-month waits for the next period', async () => {
    await ctx.db.admin.query(
      `INSERT INTO rules (key, value, valid_from, clause_ref)
       VALUES ('monthly_due_per_share_paisa', '700000', '2027-05-10', '1.4')`,
    );
    await generateDues(ctx.deps, { period: '2027-05' });
    await generateDues(ctx.deps, { period: '2027-06' });
    const m03 = async (period: string) =>
      (await dueRows(ctx.db, period)).find((r) => r.code === 'M03');
    expect(await m03('2027-05')).toMatchObject({ amount: '600000' });
    expect(await m03('2027-06')).toMatchObject({ amount: '700000' });
  });

  test('a period with no rule in force fails loudly instead of guessing an amount', async () => {
    // The seeded rules start on 2026-01-01.
    const err = await generateDues(ctx.deps, { period: '2025-12' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 500, code: 'rule.missing' });
    expect(await dueRows(ctx.db, '2025-12')).toHaveLength(0);
  });
});

describe('generateDues: start boost and the fund term', () => {
  const clock = createFakeClock(new Date('2029-01-10T03:00:00Z'));
  const { ctx, test } = useFund(clock);

  test('start boost is only created when asked for, at shares x start_boost_per_share', async () => {
    const plain = await generateDues(ctx.deps, { period: '2026-01' });
    expect(plain.created.every((c) => c.kind === 'monthly')).toBe(true);

    const result = await generateDues(ctx.deps, {
      period: '2026-01',
      kinds: ['monthly', 'start_boost'],
    });
    expect(result.created.map((c) => c.kind)).toEqual(Array(8).fill('start_boost'));
    expect(result.already_existed).toBe(8); // the monthly dues from the first run
    const rows = (await dueRows(ctx.db, '2026-01')).filter((r) => r.kind === 'start_boost');
    expect(rows.find((r) => r.code === 'M02')).toMatchObject({
      amount: '3200000',
      shares_snapshot: 4,
    });
    expect(rows.find((r) => r.code === 'M03')).toMatchObject({ amount: '800000' });
  });

  test('start boost is one-time per member: another period gets none', async () => {
    const result = await generateDues(ctx.deps, {
      period: '2026-02',
      kinds: ['monthly', 'start_boost'],
    });
    expect(result.created.filter((c) => c.kind === 'start_boost')).toHaveLength(0);
    expect(result.created.filter((c) => c.kind === 'monthly')).toHaveLength(8);
    const count = await ctx.db.admin.query(
      `SELECT count(*)::int AS n FROM dues WHERE kind = 'start_boost'`,
    );
    expect(count.rows[0]).toMatchObject({ n: 8 });
  });

  test('the last month of the term is billed, the month after is not', async () => {
    const last = await generateDues(ctx.deps, { period: '2028-12' }); // fund_term_end = 2028-12-31
    expect(last.created).toHaveLength(8);
    const after = await generateDues(ctx.deps, { period: '2029-01' });
    expect(after).toMatchObject({ skipped: 'after_fund_term', created: [] });
    expect(await dueRows(ctx.db, '2029-01')).toHaveLength(0);
  });
});

describe('generateDues: unallocated credit', () => {
  const clock = createFakeClock(NOV_5);
  const { ctx, test } = useFund(clock);

  const allocated = async (memberId: string) =>
    (
      await ctx.db.admin.query(
        `SELECT pa.payment_id, pa.amount_paisa::text AS amount
         FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
         WHERE p.member_id = $1 ORDER BY p.confirmed_at, pa.id`,
        [memberId],
      )
    ).rows as Array<{ payment_id: string; amount: string }>;
  const credit = async (paymentId: string) =>
    (
      await ctx.db.admin.query(`SELECT unallocated_paisa::text AS u FROM payments WHERE id = $1`, [
        paymentId,
      ])
    ).rows[0] as { u: string };

  test('credit pays the new due and the rest stays as credit', async () => {
    const p = await addConfirmedPayment(ctx.db.admin, ctx.fund.members.M03, 1_500_000);
    const result = await generateDues(ctx.deps, { period: '2026-11' });
    expect(result.credit_applied_paisa).toBeGreaterThan(0n);

    expect(await allocated(ctx.fund.members.M03)).toEqual([{ payment_id: p, amount: '500000' }]);
    expect(await credit(p)).toEqual({ u: '1000000' });
    const due = await ctx.db.admin.query(
      `SELECT status, outstanding_paisa::text AS o FROM v_due_status WHERE member_id = $1 AND period = '2026-11'`,
      [ctx.fund.members.M03],
    );
    expect(due.rows[0]).toMatchObject({ status: 'paid', o: '0' });
  });

  test('credit is spent oldest payment first, across payments, and a partly covered due stays partial', async () => {
    const m = ctx.fund.members.M04;
    const older = await addConfirmedPayment(ctx.db.admin, m, 300_000, {
      confirmedAt: '2026-09-01T06:00:00Z',
    });
    const newer = await addConfirmedPayment(ctx.db.admin, m, 100_000, {
      confirmedAt: '2026-10-01T06:00:00Z',
    });
    // October: M04 has no October due yet (the November run in the previous test came first).
    await generateDues(ctx.deps, { period: '2026-10' });

    expect(await allocated(m)).toEqual([
      { payment_id: older, amount: '300000' },
      { payment_id: newer, amount: '100000' },
    ]);
    expect(await credit(older)).toEqual({ u: '0' });
    expect(await credit(newer)).toEqual({ u: '0' });
    const due = await ctx.db.admin.query(
      `SELECT status, outstanding_paisa::text AS o FROM v_due_status WHERE member_id = $1 AND period = '2026-10'`,
      [m],
    );
    expect(due.rows[0]).toMatchObject({ status: 'partial', o: '100000' });
  });

  test('a re-run does not spend the credit twice', async () => {
    const before = await credit((await allocated(ctx.fund.members.M03))[0]!.payment_id);
    const again = await generateDues(ctx.deps, { period: '2026-11' });
    expect(again.credit_applied_paisa).toBe(0n);
    expect(await credit((await allocated(ctx.fund.members.M03))[0]!.payment_id)).toEqual(before);
  });

  test('credit also covers a start boost created in the same run, oldest due first', async () => {
    const m = ctx.fund.members.M06; // 1 share: monthly 500000, start boost 800000
    const p = await addConfirmedPayment(ctx.db.admin, m, 1_000_000);
    await generateDues(ctx.deps, { period: '2026-09', kinds: ['monthly', 'start_boost'] });
    const rows = (
      await ctx.db.admin.query(
        `SELECT kind, allocated_paisa::text AS a FROM v_due_status WHERE member_id = $1 AND period = '2026-09' ORDER BY kind`,
        [m],
      )
    ).rows;
    // monthly (500000) is generated first and gets its full amount; 500000 is left for the boost.
    expect(rows).toEqual([
      { kind: 'monthly', a: '500000' },
      { kind: 'start_boost', a: '500000' },
    ]);
    expect(await credit(p)).toEqual({ u: '0' });
  });

  test('pending, rejected and reversed payments never count as credit', async () => {
    const m = ctx.fund.members.M05;
    await ctx.db.admin.query(
      `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, unallocated_paisa)
       VALUES ($1, 5000000, 'cash', now(), 'pending', 'member_submitted', 0)`,
      [m],
    );
    await generateDues(ctx.deps, { period: '2026-08' });
    expect(await allocated(m)).toEqual([]);
  });
});

describe('rule lookup by date', () => {
  const { ctx, test } = useFund(createFakeClock(NOV_5));

  test('returns the row with the greatest valid_from on or before the date', async () => {
    const { admin, app } = ctx.db;
    await admin.query(
      `INSERT INTO rules (key, value, valid_from, clause_ref) VALUES
         ('monthly_due_per_share_paisa', '"600000"', '2026-07-01', '1.4'),
         ('monthly_due_per_share_paisa', '700000', '2026-09-15', '1.4')`,
    );
    const at = async (date: string) =>
      (await getRule(app, 'monthly_due_per_share_paisa', date))?.value;
    expect(await at('2026-06-30')).toBe(500000);
    expect(await at('2026-07-01')).toBe('600000'); // valid_from is inclusive
    expect(await at('2026-09-14')).toBe('600000');
    expect(await at('2026-09-15')).toBe(700000);
    expect(await at('2030-01-01')).toBe(700000);
  });

  test('is null before the first version, and requireRule-based readers fail loudly', async () => {
    const { app } = ctx.db;
    expect(await getRule(app, 'monthly_due_per_share_paisa', '2025-12-31')).toBeNull();
    expect(await getRule(app, 'no_such_rule', '2026-11-05')).toBeNull();
    await expect(rulePaisa(app, 'no_such_rule', '2026-11-05')).rejects.toMatchObject({
      code: 'rule.missing',
    });
  });

  test('paisa rules accept both a JSON number and a digit string', async () => {
    const { app } = ctx.db;
    expect(await rulePaisa(app, 'monthly_due_per_share_paisa', '2026-06-30')).toBe(500000n);
    expect(await rulePaisa(app, 'monthly_due_per_share_paisa', '2026-07-01')).toBe(600000n);
    expect(await ruleInt(app, 'due_day', '2026-06-30')).toBe(20);
  });

  test('a rule of the wrong type is rejected, not coerced', async () => {
    await expect(rulePaisa(ctx.db.app, 'reminder_time', '2026-11-05')).rejects.toMatchObject({
      code: 'rule.invalid',
    });
  });

  test('fund_term_start and fund_term_end are dates from the rules', async () => {
    expect(await fundTerm(ctx.db.app, '2026-11-05')).toEqual({
      start: '2026-01-01',
      end: '2028-12-31',
    });
    expect(await fundTerm(ctx.db.app, '2025-01-01')).toEqual({ start: null, end: null });
  });

  test('lists one row per key in force, and the full history on request', async () => {
    const inForce = await listRulesInForce(ctx.db.app, '2026-10-01');
    const keys = inForce.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(inForce.find((r) => r.key === 'monthly_due_per_share_paisa')).toMatchObject({
      value: 700000,
      valid_from: '2026-09-15',
    });
    expect(inForce.find((r) => r.key === 'fund_term_end')?.clause_ref).toBe('1.2');

    const history = await listRuleHistory(ctx.db.app, 'monthly_due_per_share_paisa');
    expect(history.map((r) => r.valid_from)).toEqual(['2026-09-15', '2026-07-01', '2026-01-01']);
  });

  test('rule rows are append-only for the app role and for everyone else', async () => {
    await expect(
      ctx.db.app.query(`UPDATE rules SET value = '1' WHERE key = 'due_day'`),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(ctx.db.admin.query(`DELETE FROM rules WHERE key = 'due_day'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
