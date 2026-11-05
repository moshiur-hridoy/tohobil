import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeClock, divRound } from '@barakah/shared';
import { createLogger } from '../lib/logger';
import { computeNav, unspentAdvance } from '../lib/nav';
import { inTransaction } from '../lib/tx';
import { computeNav as navBreakdown } from '../nav/service';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import { createTestDb, type TestDb } from '../test/db-harness';
import { addConfirmedPayment, seedFund, type Fund } from '../test/fund-fixture';
import { computeSettlementQuote, estimateSettlement, executeSettlement } from './settlement';
import { computeMemberFinancials } from './status';

// Money paid ahead is the member's until the month it pays comes (docs/ASSUMPTIONS.md 120).
const TODAY = '2026-11-15';
const clock = createFakeClock(new Date(`${TODAY}T10:00:00Z`));
const deps = () => ({
  pool: db!.app,
  clock,
  pushSender: { send: async (tokens: string[]) => tokens.map(() => ({ ok: true })) } as unknown as PushSender,
  smsProvider: { send: async () => ({ ok: true }) } as unknown as SmsProvider,
  log: createLogger('silent'),
});

let db: TestDb | null;
let fund: Fund;
const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

/** A confirmed payment of `amount` paisa from `code`, all of it still unspent credit, as the ledger books it. */
async function payAhead(code: keyof Fund['members'], amount: number): Promise<string> {
  const member = fund.members[code];
  const paymentId = await addConfirmedPayment(db!.admin, member, amount, { unallocated: amount });
  await q(
    `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id)
     VALUES ($1, 'BANK', 'MEMBER_CAPITAL', $2, $3, 'payment', $4)`,
    [TODAY, amount, member, paymentId],
  );
  return paymentId;
}

async function placeholderProposal(memberId: string): Promise<string> {
  const rows = await q(
    `INSERT INTO proposals (type, title, subject_member_id, payload, created_by, status)
     VALUES ('settlement', 'Test settlement', $1, '{}', $2, 'executed') RETURNING id`,
    [memberId, fund.users.M01],
  );
  return (rows[0] as { id: string }).id;
}

async function quoteDeath(memberId: string) {
  const estimate = await estimateSettlement(db!.app, clock, memberId, 'death_surrender');
  const net = BigInt(estimate.net_paisa);
  const proposalId = await placeholderProposal(memberId);
  const quote = await inTransaction(db!.app, (tx) =>
    computeSettlementQuote(tx, deps(), memberId, {
      kind: 'death_surrender',
      payout_plan: [{ due_on: TODAY, amount_paisa: net }],
      proposal_id: proposalId,
    }),
  );
  return { estimate, quote };
}

const execute = (settlementId: string) =>
  inTransaction(db!.app, (tx) => executeSettlement(tx, deps(), settlementId, { userId: fund.users.M01, ip: undefined, deviceId: null }));

beforeAll(async () => {
  db = await createTestDb();
  if (db) fund = await seedFund(db.admin);
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

describe('advance paid ahead', () => {
  dbIt('raises nobody\'s share value until the month comes, and is counted as owed to the member', async () => {
    const before = await computeNav(db!.admin, TODAY);
    const paymentId = await payAhead('M03', 20_000);

    const after = await computeNav(db!.admin, TODAY);
    expect(after.cash_paisa - before.cash_paisa).toBe(20_000n);
    expect(after.advance_paisa).toBe(20_000n);
    expect(after.net_assets).toBe(before.net_assets);

    // GET /nav and the settlement figures agree
    const breakdown = await navBreakdown({ pool: db!.app, clock });
    expect(breakdown.net_assets_paisa).toBe(after.net_assets);
    expect(breakdown.deductions.find((d) => d.account === 'MEMBER_ADVANCE')?.balance_paisa).toBe(20_000n);
    const fin = await computeMemberFinancials(db!.app, fund.members.M03, TODAY);
    expect(fin.netAssets).toBe(after.net_assets);
    expect(fin.advance).toBe(20_000n);

    // the month comes and the credit is spent on its due: now it is share capital like everyone's dues
    await q(`UPDATE payments SET unallocated_paisa = 0 WHERE id = $1`, [paymentId]);
    expect((await computeNav(db!.admin, TODAY)).net_assets).toBe(before.net_assets + 20_000n);
  });

  dbIt('a death settlement pays the advance back on top of the shares\' value and clears it', async () => {
    const member = fund.members.M04;
    await payAhead('M04', 30_000);
    const fin = await computeMemberFinancials(db!.app, member, TODAY);
    const shareValue = divRound(fin.netAssets * BigInt(fin.shares), BigInt(fin.sharesOutstanding));

    const { estimate, quote } = await quoteDeath(member);
    expect(BigInt(estimate.advance_in_gross_paisa)).toBe(30_000n);
    expect(quote.gross).toBe(shareValue + 30_000n);

    await execute(quote.settlement_id);
    expect(await unspentAdvance(db!.admin, member)).toBe(0n);
    const [entry] = (await q(
      `SELECT amount_paisa::text AS amount FROM ledger_entries
       WHERE member_id = $1 AND debit_account = 'MEMBER_CAPITAL' AND credit_account = 'SETTLEMENT_PAYABLE'`,
      [member],
    )) as Array<{ amount: string }>;
    expect(BigInt(entry!.amount)).toBe(quote.gross - quote.deductions.total);
  });

  dbIt('a quote whose advance was spent in the meantime is refused, not paid twice', async () => {
    const member = fund.members.M05;
    const paymentId = await payAhead('M05', 10_000);
    const { quote } = await quoteDeath(member);

    await q(`UPDATE payments SET unallocated_paisa = 4000 WHERE id = $1`, [paymentId]);
    await expect(execute(quote.settlement_id)).rejects.toMatchObject({ code: 'settlement.advance_changed' });
    expect(await unspentAdvance(db!.admin, member)).toBe(4_000n);
  });
});
