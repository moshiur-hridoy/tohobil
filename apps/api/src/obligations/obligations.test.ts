import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';
import { computeNav } from '../lib/nav';
import { generateDues } from '../dues/service';
import { executeProposal, type ClientCtx } from '../proposals/service';

const START = new Date('2026-11-05T03:00:00Z'); // 5 Nov 2026, 09:00 in Dhaka
const TODAY = '2026-11-05';
const clock = createFakeClock(START);

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const cashier = {} as TestSession;
const member = {} as TestSession;
const secrets = new Map<string, string>();

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${who}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const balance = async (account: string): Promise<bigint> =>
  BigInt(((await q(`SELECT natural_balance_paisa::text AS n FROM v_account_balances WHERE code=$1`, [account]))[0]?.n as string | undefined) ?? '0');

const netAssets = async (): Promise<bigint> => (await computeNav(db!.admin, TODAY)).net_assets;

async function actor() {
  const row = (await q(
    `SELECT u.id, u.member_id, m.code AS member_code, m.full_name, u.roles, u.status AS user_status,
            m.status AS member_status, u.totp_enabled, d.id AS device_id
     FROM users u JOIN members m ON m.id = u.member_id
     JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL
     WHERE m.code = 'M01' LIMIT 1`,
  ))[0] as never;
  return { ...(row as object), step_up_at: null } as never;
}

async function approved(type: string, payload: Record<string, unknown>): Promise<string> {
  const res = await db!.admin.query(
    `INSERT INTO proposals (type, title, payload, status, finalized_at, amount_paisa, created_by)
     VALUES ($1, $2, $3, 'approved', now(), $4, $5) RETURNING id`,
    [type, `Test ${type}`, JSON.stringify(payload), (payload.max_amount_paisa as string | undefined) ?? null, fund.users.M01],
  );
  return (res.rows[0] as { id: string }).id;
}

async function execute(pid: string, input: Record<string, unknown> = {}) {
  const a = await actor();
  const ctx: ClientCtx = { ip: '127.0.0.1', user: a };
  return executeProposal({ pool: db!.app, clock }, a, pid, input as never, ctx);
}

async function enrolStepUp(session: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', session.access_token);
  secrets.set(session.device_id, (enrol.json() as { secret: string }).secret);
  // The app runs on the fake clock, so the code must be generated for that moment too.
  const code = authenticator.clone({ epoch: clock.now().getTime() }).generate(secrets.get(session.device_id) as string);
  const res = await call('POST', '/auth/totp/verify', session.access_token, { code });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

async function plantAsset(kind: string, status: string, cost: number, extra: { proposalId?: string; split?: unknown } = {}) {
  const res = await db!.admin.query(
    `INSERT INTO assets (kind, name, cost_paisa, status, proposal_id, ownership_split)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [kind, `Test ${kind}`, cost, status, extra.proposalId ?? null, extra.split ? JSON.stringify(extra.split) : null],
  );
  return (res.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  Object.assign(cashier, await activateSession(app, db, clock, fund, 'M01'));
  Object.assign(member, await activateSession(app, db, clock, fund, 'M02'));
  await enrolStepUp(cashier);
  // 10,000 BDT of cash so there is something to move.
  await q(
    `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, ref_type, memo)
     VALUES ($1, 'BANK', 'MEMBER_CAPITAL', 1000000, 'import', 'opening cash')`,
    [TODAY],
  ).catch(() => undefined);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn();
  });
}

describe('investment checks before voting', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    kind: 'gold',
    name: 'Gold',
    max_amount_paisa: '500000',
    source_account: 'BANK',
    compliance: {
      interest_free_instrument: true,
      not_conventional_fixed_deposit: true,
      not_conventional_insurance: true,
      not_speculative_trading: true,
      permissible_business: true,
      liquidatable_within_term: true,
      no_fixed_profit_promised: true,
    },
    ...over,
  });

  const draft = async (p: Record<string, unknown>) => {
    const res = await call('POST', '/proposals', member.access_token, { type: 'investment_purchase', title: 'Buy', payload: p });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  };
  const open = (id: string) =>
    call('POST', `/proposals/${id}/open`, cashier.access_token, { closes_at: '2026-11-10T03:00:00Z' });

  dbIt('refuses to open with an unticked compliance box', async () => {
    const id = await draft(payload({ compliance: { ...payload().compliance, permissible_business: false } }));
    const res = await open(id);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('proposal.compliance_incomplete');
    expect(res.json().unticked).toEqual(['permissible_business']);
  });

  dbIt('refuses to open without a feasibility file, then opens once it is attached', async () => {
    const id = await draft(payload());
    expect((await open(id)).json().code).toBe('proposal.feasibility_required');

    const file = await q(
      `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by)
       VALUES ($1,'application/pdf',10,'/x','f.pdf',$2) RETURNING id`,
      ['b'.repeat(64), fund.users.M01],
    );
    const ok = await draft(payload({ feasibility_file_id: (file[0] as { id: string }).id }));
    expect((await open(ok)).statusCode).toBe(200);
  });
});

describe('buying land in stages', () => {
  dbIt('staged payments stop at the approved maximum, and completing needs the deed and the split', async () => {
    const pid = await approved('investment_purchase', { max_amount_paisa: '400000' });
    const land = await plantAsset('land', 'acquiring', 100000, { proposalId: pid });

    const pay = (amount: string) =>
      call('POST', `/assets/${land}/payments`, cashier.access_token, { amount_paisa: amount, account: 'BANK', note: 'second instalment' });
    const bankBefore = await balance('BANK');
    expect((await pay('200000')).statusCode).toBe(200);
    expect(bankBefore - (await balance('BANK'))).toBe(200000n);
    expect((await q(`SELECT cost_paisa::text AS c FROM assets WHERE id=$1`, [land]))[0]?.c).toBe('300000');
    const over = await pay('200000'); // 300,000 + 200,000 > 400,000
    expect(over.statusCode).toBe(400);
    expect(over.json().code).toBe('asset.exceeds_approved');

    const complete = () => call('POST', `/assets/${land}/complete`, cashier.access_token, { note: 'Registered at the land office' });
    expect((await complete()).json().code).toBe('asset.document_required');

    const file = await q(
      `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by)
       VALUES ($1,'application/pdf',10,'/y','d.pdf',$2) RETURNING id`,
      ['c'.repeat(64), fund.users.M01],
    );
    const fileId = (file[0] as { id: string }).id;
    await call('POST', `/assets/${land}/documents`, cashier.access_token, { file_id: fileId, doc_type: 'receipt' });
    expect((await complete()).json().code).toBe('asset.deed_required');

    await call('POST', `/assets/${land}/documents`, cashier.access_token, { file_id: fileId, doc_type: 'deed' });
    expect((await complete()).json().code).toBe('asset.ownership_split_mismatch');

    const split = Object.values(fund.members).map((member_id, i) => ({ member_id, shares: [2, 4, 1, 1, 3, 1, 4, 4][i] }));
    expect((await call('PATCH', `/assets/${land}`, cashier.access_token, { ownership_split: split })).statusCode).toBe(200);
    const done = await complete();
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('held');
    expect((await pay('1')).json().code).toBe('asset.not_acquiring');
  });
});

describe('levy', () => {
  dbIt('creates levy dues by shares, holds the money in clearing (never NAV) and hands it to the registrar', async () => {
    const nav0 = await netAssets();
    const pid = await approved('asset_cost_levy', { total_paisa: '2000000', due_date: '2026-12-15', reason: 'Registration' });
    await execute(pid);

    const dues = await q(`SELECT member_id, amount_paisa::text AS a, shares_snapshot FROM dues WHERE kind='levy' ORDER BY amount_paisa DESC`);
    expect(dues).toHaveLength(8);
    expect(dues.reduce((s, d) => s + BigInt(d.a as string), 0n)).toBe(2000000n); // 20 shares: 100,000 per share
    expect(dues[0]).toMatchObject({ a: '400000', shares_snapshot: 4 });

    // a second levy in the same month is refused rather than silently merged
    const again = await approved('asset_cost_levy', { total_paisa: '100', due_date: '2026-12-20', reason: 'Second levy' });
    await expect(execute(again)).rejects.toMatchObject({ code: 'levy.period_taken' });

    const m2 = fund.members.M02; // 4 shares -> 400,000
    const paid = await call('POST', '/payments/cashier-entry', cashier.access_token, {
      member_id: m2,
      amount_paisa: '400000',
      method: 'cash',
      purpose: 'levy',
      paid_at: '2026-11-05T03:00:00Z',
    });
    expect(paid.statusCode).toBe(201);
    expect(await balance('LEVY_CLEARING')).toBe(400000n);
    expect(await netAssets()).toBe(nav0); // cash up, clearing liability up: the fund is no richer

    const remit = (amount: string) =>
      call('POST', '/levy/remittances', cashier.access_token, { amount_paisa: amount, account: 'CASH', payee: 'Sub-registrar', note: 'Registration fee' });
    expect((await remit('500000')).json().code).toBe('levy.exceeds_held');
    expect((await remit('400000')).statusCode).toBe(200);
    expect(await balance('LEVY_CLEARING')).toBe(0n);

    const summary = (await call('GET', '/levy', member.access_token)).json();
    expect(summary.held_paisa).toBe('0');
    expect(summary.remittances).toHaveLength(1);
  });
});

describe('member qard (interest-free loan to the fund)', () => {
  dbIt('receives and repays without ever exceeding what the member lent, and NAV is unmoved', async () => {
    const nav0 = await netAssets();
    const m = fund.members.M03;
    await execute(await approved('member_qard', { direction: 'receive', lender_member_id: m, amount_paisa: '300000', account: 'BANK' }));
    expect((await q(`SELECT natural_balance_paisa::text AS n FROM v_account_balances WHERE code='MEMBER_QARD'`))[0]?.n).toBe('300000');
    expect(await netAssets()).toBe(nav0);

    const tooMuch = await approved('member_qard', { direction: 'repay', lender_member_id: m, amount_paisa: '400000', account: 'BANK' });
    await expect(execute(tooMuch)).rejects.toMatchObject({ code: 'qard.exceeds_balance' });
    await execute(await approved('member_qard', { direction: 'repay', lender_member_id: m, amount_paisa: '100000', account: 'BANK' }));
    expect(await balance('MEMBER_QARD')).toBe(200000n);
  });
});

describe('deferred purchase', () => {
  dbIt('books the asset against the payable, checks the instalments and pays them one by one', async () => {
    const nav0 = await netAssets();
    const asset = await plantAsset('house', 'acquiring', 0);
    const bad = await approved('financing_arrangement', {
      asset_id: asset, counterparty: 'Islamic Bank', description: 'Hire purchase', total_paisa: '1000000',
      instalments: [{ due_on: '2026-12-01', amount_paisa: '600000' }, { due_on: '2027-01-01', amount_paisa: '300000' }],
    });
    await expect(execute(bad)).rejects.toMatchObject({ code: 'financing.instalments_mismatch' });

    await execute(await approved('financing_arrangement', {
      asset_id: asset, counterparty: 'Islamic Bank', description: 'Hire purchase', total_paisa: '1000000',
      instalments: [{ due_on: '2026-12-01', amount_paisa: '600000' }, { due_on: '2027-01-01', amount_paisa: '400000' }],
    }));
    expect(await balance('DEFERRED_PURCHASE_PAYABLE')).toBe(1000000n);
    expect((await q(`SELECT cost_paisa::text AS c FROM assets WHERE id=$1`, [asset]))[0]?.c).toBe('1000000');
    expect(await netAssets()).toBe(nav0); // asset in, payable out

    const list = (await call('GET', '/financing', member.access_token)).json().items as Array<{ instalments: Array<{ id: string }> }>;
    const first = list[0]!.instalments[0]!.id;
    const pay = () => call('POST', `/financing/instalments/${first}/pay`, cashier.access_token, { account: 'BANK' });
    expect((await pay()).statusCode).toBe(200);
    expect(await balance('DEFERRED_PURCHASE_PAYABLE')).toBe(400000n);
    expect((await pay()).json().code).toBe('financing.already_paid');
  });
});

describe('winding up', () => {
  dbIt('stops dues and new members, once', async () => {
    const pid = await approved('wind_up', { asset_ids_to_sell: [], distribution_plan: 'Sell everything, pay by shares' });
    await execute(pid);
    expect((await q(`SELECT 1 FROM settings WHERE key='wind_up'`)).length).toBe(1);

    const result = await generateDues({ pool: db!.app, clock }, { period: '2026-11' });
    expect(result.skipped).toBe('winding_up');

    const newMember = await approved('new_member', { name: 'Late Joiner', phone: '+8801733333333', shares: 1 });
    await expect(execute(newMember)).rejects.toMatchObject({ code: 'wind_up.no_new_members' });
    await expect(execute(await approved('wind_up', { asset_ids_to_sell: [], distribution_plan: 'again' }))).rejects.toMatchObject({
      code: 'wind_up.already_started',
    });
  });
});

describe('no loan path (spec 18.7)', () => {
  dbIt('cash only ever leaves to a member through a settlement, escrow payout, distribution, qard repayment or donation', async () => {
    const rows = await q(
      `SELECT e.ref_type, p.type AS proposal_type
       FROM ledger_entries e LEFT JOIN proposals p ON p.id = e.ref_id AND e.ref_type = 'proposal'
       WHERE e.credit_account IN ('CASH','BANK','BKASH','NAGAD') AND e.member_id IS NOT NULL AND e.reverses_seq IS NULL`,
    );
    const allowedRef = ['settlement_payout', 'escrow_payout', 'charity_donation'];
    const allowedProposal = ['distribution', 'member_qard', 'charity_donation', 'settlement'];
    for (const r of rows) {
      const ok = allowedRef.includes(r.ref_type as string) || (r.ref_type === 'proposal' && allowedProposal.includes(r.proposal_type as string));
      // member payments are credits to member capital (debits of cash), so any row here is an outflow
      expect(ok, `unexpected cash outflow to a member: ${JSON.stringify(r)}`).toBe(true);
    }
    expect(rows.length).toBeGreaterThan(0); // the qard repayment above must have been seen
  });
});
