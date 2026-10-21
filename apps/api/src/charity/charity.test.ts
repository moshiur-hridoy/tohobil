import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import { inTransaction, type Db } from '../lib/tx';
import { postEntries, LEDGER_REF } from '../ledger/service';
import { recordDonationReceipt, listCharityDonations, charityStatement, listFundExpenses } from './service';

describe('charity donations', () => {
  let db: TestDb | null = null;
  let fund: Fund;
  const clock = createFakeClock(new Date('2026-08-15T06:00:00Z'));

  async function one<T>(client: pg.Pool | pg.PoolClient, sql: string, params: unknown[]): Promise<T> {
    const res = await client.query(sql, params);
    return res.rows[0] as T;
  }

  async function createCharityProposal(client: Db, amount: bigint): Promise<string> {
    const res = await client.query(
      `INSERT INTO proposals (type, title, payload, status, basis, threshold_kind, eligible_count, eligible_weight, threshold, threshold_weight, created_by)
       VALUES (
         'charity_donation', 'Donation to orphanage',
         $1::jsonb, 'approved', 'member', 'majority', 1, 1, 1, 1, $2
       )
       RETURNING id`,
      [
        JSON.stringify({
          recipient: 'Test Orphanage',
          amount_paisa: amount.toString(),
          purpose: 'Annual charity',
        }),
        fund.users.M01,
      ],
    );
    return (res.rows[0] as { id: string }).id;
  }

  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    fund = await seedFund(db.admin);
  });

  afterAll(async () => {
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  dbIt('records a donation receipt, posts the ledger and links them', async () => {
    // Seed charity balance from a bank interest receipt.
    await inTransaction(db!.app, async (tx) => {
      await postEntries(
        tx,
        [
          {
            entry_date: clock.todayDhaka(),
            debit: 'BANK',
            credit: 'CHARITY_PAYABLE',
            amount_paisa: 100_000n,
            member_id: null,
            ref_type: LEDGER_REF.ribaReceived,
            memo: 'Bank interest (charity)',
          },
        ],
        { userId: fund.users.M01 },
      );
    });

    const proposalAmount = 100_000n;
    const proposalId = await createCharityProposal(db!.app, proposalAmount);

    const out = await recordDonationReceipt(db!.app, { pool: db!.app, clock }, {
      proposal_id: proposalId,
      actual_amount_paisa: 80_000n,
      method: 'bank',
      actor: { userId: fund.users.M01 },
    });
    expect(out.donation_id).toBeTruthy();
    expect(out.ledger_seq).toBeTruthy();

    const donation = await one<{ ledger_seq: string; amount_paisa: string; recipient: string }>(
      db!.admin,
      `SELECT ledger_seq, amount_paisa::text, recipient
       FROM charity_donations WHERE id = $1`,
      [out.donation_id],
    );
    expect(BigInt(donation.amount_paisa)).toBe(80_000n);
    expect(donation.recipient).toBe('Test Orphanage');

    const ledger = await one<{ debit_account: string; credit_account: string; amount_paisa: string }>(
      db!.admin,
      `SELECT debit_account, credit_account, amount_paisa::text
       FROM ledger_entries WHERE seq = $1`,
      [donation.ledger_seq],
    );
    expect(ledger.debit_account).toBe('CHARITY_PAYABLE');
    expect(ledger.credit_account).toBe('BANK');
    expect(BigInt(ledger.amount_paisa)).toBe(80_000n);

    // Not enough balance left for another full donation.
    await expect(
      recordDonationReceipt(db!.app, { pool: db!.app, clock }, {
        proposal_id: proposalId,
        actual_amount_paisa: 80_000n,
        method: 'bank',
        actor: { userId: fund.users.M01 },
      }),
    ).rejects.toThrow(/approved/);
  });

  dbIt('statement aggregates receipts, disbursements and balance', async () => {
    await inTransaction(db!.app, async (tx) => {
      await postEntries(
        tx,
        [
          {
            entry_date: '2026-01-05',
            debit: 'BKASH',
            credit: 'CHARITY_PAYABLE',
            amount_paisa: 50_000n,
            member_id: null,
            ref_type: LEDGER_REF.payment,
            memo: 'fine to charity',
          },
          {
            entry_date: '2026-01-10',
            debit: 'CHARITY_PAYABLE',
            credit: 'BANK',
            amount_paisa: 30_000n,
            member_id: null,
            ref_type: LEDGER_REF.charityDonation,
            memo: 'donation',
          },
        ],
        { userId: fund.users.M01 },
      );
    });

    // The first test already posted 100k in and donated 80k out in 2026; those carry over.
    const st = await charityStatement(db!.app, '2026');
    expect(BigInt(st.opening_paisa)).toBe(0n);
    expect(BigInt(st.receipts_paisa)).toBe(150_000n);
    expect(BigInt(st.disbursements_paisa)).toBe(110_000n);
    expect(BigInt(st.closing_paisa)).toBe(40_000n);

    const list = await listCharityDonations(db!.app, '2026-01-01', '2026-12-31');
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    const totalDonated = list.items.reduce((sum, i) => sum + BigInt(i.amount_paisa), 0n);
    expect(totalDonated).toBeGreaterThanOrEqual(80_000n);

    // The movements behind the totals add up to them, oldest first.
    const sumOf = (dir: 'in' | 'out') =>
      st.entries.filter((e) => e.direction === dir).reduce((s, e) => s + BigInt(e.amount_paisa), 0n);
    expect(sumOf('in')).toBe(150_000n);
    expect(sumOf('out')).toBe(110_000n);
    expect(st.entries.map((e) => e.entry_date)).toEqual([...st.entries.map((e) => e.entry_date)].sort());
    expect(st.entries.find((e) => e.memo === 'donation')).toMatchObject({ direction: 'out', kind: 'donation' });
  });

  dbIt('lists fines by member and keeps the fund’s own expenses apart', async () => {
    await inTransaction(db!.app, async (tx) => {
      await postEntries(
        tx,
        [
          {
            entry_date: '2025-03-02',
            debit: 'CASH',
            credit: 'CHARITY_PAYABLE',
            amount_paisa: 20_000n,
            member_id: fund.members.M01,
            ref_type: LEDGER_REF.payment,
            memo: 'late fine',
          },
          {
            entry_date: '2025-03-04',
            debit: 'BANK',
            credit: 'CHARITY_PAYABLE',
            amount_paisa: 3_900n,
            member_id: null,
            ref_type: LEDGER_REF.ribaReceived,
            memo: 'bank profit',
          },
          {
            entry_date: '2025-12-28',
            debit: 'SMS_CHARGE',
            credit: 'BANK',
            amount_paisa: 34_500n,
            member_id: null,
            ref_type: LEDGER_REF.import,
            memo: 'Bank Account SMS Charge',
          },
        ],
        { userId: fund.users.M01 },
      );
    });

    const st = await charityStatement(db!.app, '2025');
    expect(st.entries).toHaveLength(2);
    expect(st.entries[0]).toMatchObject({ direction: 'in', kind: 'fine', member_code: 'M01', amount_paisa: '20000' });
    expect(st.entries[1]).toMatchObject({ direction: 'in', kind: 'bank_profit', member_code: null });
    // The SMS charge is the fund's cost, not charity money.
    expect(st.closing_paisa).toBe('23900');
    // Without a year: the whole history, which ends where the latest year ends.
    const all = await charityStatement(db!.app);
    expect(all).toMatchObject({ year: null, opening_paisa: '0' });
    expect(all.closing_paisa).toBe((await charityStatement(db!.app, '2026')).closing_paisa);
    expect(all.entries.length).toBeGreaterThan(st.entries.length);

    const expenses = await listFundExpenses(db!.app);
    expect(expenses.total_paisa).toBe('34500');
    expect(expenses.items).toEqual([
      expect.objectContaining({ account: 'SMS_CHARGE', entry_date: '2025-12-28', amount_paisa: '34500' }),
    ]);
  });
});
