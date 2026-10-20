import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createFakeClock } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import { inTransaction, type Db } from '../lib/tx';
import { postEntries, LEDGER_REF } from '../ledger/service';
import { recordDonationReceipt, listCharityDonations, charityStatement } from './service';

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
  });
});
