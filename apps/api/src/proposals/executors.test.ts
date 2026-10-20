import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';
import { computeNav } from '../lib/nav';
import { executeProposal, type ClientCtx } from './service';

const START = new Date('2026-11-05T03:00:00Z'); // 09:00 Dhaka

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M03' | 'M04' | 'M07', TestSession>;

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

async function actorFor(memberCode: 'M01' | 'M02' | 'M03' | 'M04' | 'M07') {
  const row = (await q(
    `SELECT u.id, u.member_id, m.code AS member_code, m.full_name, u.roles,
            u.status AS user_status, m.status AS member_status, u.totp_enabled, d.id AS device_id
     FROM users u
     JOIN members m ON m.id = u.member_id
     JOIN devices d ON d.user_id = u.id AND d.revoked_at IS NULL
     WHERE m.code = $1
     LIMIT 1`,
    [memberCode],
  ))[0] as {
    id: string;
    member_id: string;
    member_code: string;
    full_name: string;
    roles: string[];
    user_status: 'pending_activation' | 'active' | 'disabled';
    member_status: string;
    totp_enabled: boolean;
    device_id: string;
  };
  return {
    ...row,
    step_up_at: null,
  };
}

async function approvedProposal(
  type: string,
  payload: Record<string, unknown>,
  subjectMemberId?: string,
): Promise<string> {
  const res = await db!.admin.query(
    `INSERT INTO proposals (type, title, payload, subject_member_id, status, finalized_at, amount_paisa, created_by)
     VALUES ($1, $2, $3, $4, 'approved', now(), $5, $6)
     RETURNING id`,
    [type, `Test ${type}`, JSON.stringify(payload), subjectMemberId ?? null, (payload.max_amount_paisa as string | undefined) ?? null, fund.users.M01],
  );
  return (res.rows[0] as { id: string }).id;
}

const balance = async (account: string): Promise<bigint> => {
  const rows = await q(
    `SELECT natural_balance_paisa::text AS net FROM v_account_balances WHERE code=$1`,
    [account],
  );
  return BigInt((rows[0]?.net as string | undefined) ?? '0');
};

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  const clock = createFakeClock(START);
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  for (const code of ['M01', 'M02', 'M03', 'M04', 'M07'] as const) {
    s[code] = await activateSession(app, db, clock, fund, code);
  }
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

describe('proposal executors', () => {
  dbIt('waives fines on execute', async () => {
    const memberId = fund.members.M03;
    const due = (await q(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, '2026-11', 'monthly', 1, 500000, '2026-11-20')
       RETURNING id`,
      [memberId],
    ))[0] as { id: string };
    const fine = (await q(
      `INSERT INTO fines (due_id, member_id, amount_paisa) VALUES ($1, $2, 50000) RETURNING id`,
      [due.id, memberId],
    ))[0] as { id: string };

    const pid = await approvedProposal('fine_waiver', { fine_ids: [fine.id], reason: 'test' });
    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };
    const res = await executeProposal({ pool: db!.app, clock: createFakeClock(START) }, actor, pid, {}, ctx);

    expect(res.status).toBe('executed');
    const rows = await q(`SELECT waived_by_proposal, waived_at FROM fines WHERE id=$1`, [fine.id]);
    expect((rows[0] as { waived_by_proposal: string }).waived_by_proposal).toBe(pid);
    expect((rows[0] as { waived_at: Date | null }).waived_at).toBeTruthy();
  });

  dbIt('posts an expense up to the approved maximum', async () => {
    const pid = await approvedProposal('expense', {
      max_amount_paisa: '100000',
      account: 'MAINTENANCE',
      payee: 'Plumber',
      purpose: 'Fix leak',
    });

    const before = await balance('BANK');
    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };
    const res = await executeProposal(
      { pool: db!.app, clock: createFakeClock(START) },
      actor,
      pid,
      { actual_amount_paisa: 80000n, account: 'BANK' },
      ctx,
    );

    expect(res.status).toBe('executed');
    expect(before - (await balance('BANK'))).toBe(80000n);
    expect(await balance('MAINTENANCE')).toBe(80000n);
    const rows = await q(`SELECT * FROM ledger_entries WHERE ref_type='proposal' AND ref_id=$1`, [pid]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ debit_account: 'MAINTENANCE', credit_account: 'BANK', amount_paisa: '80000' });
  });

  dbIt('rejects an expense that exceeds the approved maximum', async () => {
    const pid = await approvedProposal('expense', {
      max_amount_paisa: '100000',
      account: 'MAINTENANCE',
      payee: 'x',
      purpose: 'fix leak',
    });
    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };
    await expect(
      executeProposal(
        { pool: db!.app, clock: createFakeClock(START) },
        actor,
        pid,
        { actual_amount_paisa: 200000n, account: 'BANK' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'proposal.amount_exceeds_approved' });
  });

  dbIt('inserts a new rule on rule_change execution', async () => {
    const pid = await approvedProposal('rule_change', {
      key: 'monthly_due_per_share_paisa',
      value: '600000',
      valid_from: '2026-11-05',
    });

    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };
    const res = await executeProposal({ pool: db!.app, clock: createFakeClock(START) }, actor, pid, {}, ctx);

    expect(res.status).toBe('executed');
    const rows = await q(`SELECT id, value, proposal_id FROM rules WHERE proposal_id=$1`, [pid]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { value: string }).value).toBe('600000');
    expect((rows[0] as { proposal_id: string }).proposal_id).toBe(pid);
  });

  dbIt('swaps auditor role when the auditor executes role_change', async () => {
    const pid = await approvedProposal('role_change', { role: 'auditor', member_id: fund.members.M02 }, fund.members.M02);

    const auditor = await actorFor('M07');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: auditor };
    const res = await executeProposal({ pool: db!.app, clock: createFakeClock(START) }, auditor, pid, {}, ctx);

    expect(res.status).toBe('executed');
    const m07Roles = ((await q(`SELECT roles FROM users WHERE id=$1`, [fund.users.M07]))[0] as { roles: string[] }).roles;
    expect(m07Roles).not.toContain('auditor');
    const m02Roles = ((await q(`SELECT roles FROM users WHERE id=$1`, [fund.users.M02]))[0] as { roles: string[] }).roles;
    expect(m02Roles).toContain('auditor');
  });

  dbIt('rejects role_change execution by the cashier', async () => {
    const pid = await approvedProposal('role_change', { role: 'auditor', member_id: fund.members.M02 }, fund.members.M02);

    const cashier = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: cashier };
    await expect(
      executeProposal({ pool: db!.app, clock: createFakeClock(START) }, cashier, pid, {}, ctx),
    ).rejects.toMatchObject({ code: 'proposal.wrong_executor_role', status: 403 });
  });

  dbIt('distributes cash by shares and holds suspended members portion in escrow', async () => {
    // Put cash in the fund: 5,000,000 paisa in BANK.
    await q(
      `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, ref_type, ref_id, memo)
       VALUES ('2026-11-05', 'BANK', 'MEMBER_CAPITAL', 5000000, 'seed', $1, 'seed cash')`,
      [randomUUID()],
    );

    // Suspend M04 (1 share).
    await q(`UPDATE members SET status = 'suspended', suspended_on = '2026-11-01' WHERE id = $1`, [fund.members.M04]);

    const pid = await approvedProposal('distribution', {
      total_paisa: '100000',
      source_account: 'BANK',
    });

    const beforeBank = await balance('BANK');
    const beforeDistributions = await balance('DISTRIBUTIONS');
    const beforeEscrow = await balance('MEMBER_ESCROW');

    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };
    const res = await executeProposal({ pool: db!.app, clock: createFakeClock(START) }, actor, pid, {}, ctx);

    expect(res.status).toBe('executed');
    // 20 shares outstanding; M04 has 1 -> 5,000 paisa to escrow, 95,000 cash out.
    expect(await balance('DISTRIBUTIONS')).toBe(beforeDistributions + 100000n);
    expect(beforeBank - (await balance('BANK'))).toBe(95000n);
    expect(await balance('MEMBER_ESCROW')).toBe(beforeEscrow + 5000n);

    const escrowRows = await q(
      `SELECT amount_paisa::text AS amount FROM ledger_entries
       WHERE ref_type='proposal' AND ref_id=$1 AND credit_account='MEMBER_ESCROW'`,
      [pid],
    );
    expect(escrowRows).toHaveLength(1);
    expect((escrowRows[0] as { amount: string }).amount).toBe('5000');
  });

  dbIt('new_member fails on stale valuations and succeeds after refresh', async () => {
    // Held asset with no valuation => stale.
    const asset = (await q(
      `INSERT INTO assets (kind, name, cost_paisa, status, acquired_on)
       VALUES ('gold', 'Test Gold', 1000000, 'held', '2026-01-01') RETURNING id`,
    ))[0] as { id: string };

    const stalePid = await approvedProposal('new_member', {
      name: 'New Member One',
      phone: '+8801711111111',
      shares: 2,
    });
    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };

    await expect(
      executeProposal({ pool: db!.app, clock: createFakeClock(START) }, actor, stalePid, {}, ctx),
    ).rejects.toMatchObject({ code: 'nav.stale_valuation' });

    // Refresh valuation today.
    await q(
      `INSERT INTO asset_valuations (asset_id, value_paisa, as_of, basis) VALUES ($1, 1200000, '2026-11-05', 'market')`,
      [asset.id],
    );

    // Nav now = 5m cash + 1.2m gold = 6.2m across 20 shares -> price per share 310,000.
    const nav = await computeNav(db!.admin, '2026-11-05');
    const expectedPrice = (nav.net_assets * 2n) / BigInt(nav.shares_outstanding);

    const freshPid = await approvedProposal('new_member', {
      name: 'New Member Two',
      phone: '+8801722222222',
      shares: 2,
    });
    const res = await executeProposal({ pool: db!.app, clock: createFakeClock(START) }, actor, freshPid, {}, ctx);
    expect(res.status).toBe('executed');

    const members = await q(`SELECT id, status, full_name FROM members WHERE phone = $1`, ['+8801722222222']);
    expect(members).toHaveLength(1);
    expect((members[0] as { status: string }).status).toBe('prospective');

    const quotes = await q(`SELECT price_paisa::text AS price, shares_outstanding FROM entry_quotes WHERE proposal_id=$1`, [freshPid]);
    expect(quotes).toHaveLength(1);
    expect(Number((quotes[0] as { price: string }).price)).toBe(Number(expectedPrice));
  });

  dbIt('suspends a member and writes a suspension snapshot', async () => {
    const pid = await approvedProposal('suspension', { member_id: fund.members.M03, reason: 'test' }, fund.members.M03);

    const actor = await actorFor('M01');
    const ctx: ClientCtx = { ip: '127.0.0.1', user: actor };
    const res = await executeProposal({ pool: db!.app, clock: createFakeClock(START) }, actor, pid, {}, ctx);

    expect(res.status).toBe('executed');
    const status = ((await q(`SELECT status FROM members WHERE id=$1`, [fund.members.M03]))[0] as { status: string }).status;
    expect(status).toBe('suspended');

    const events = await q(`SELECT id FROM member_status_events WHERE member_id=$1 AND to_status='suspended'`, [fund.members.M03]);
    expect(events).toHaveLength(1);

    const snaps = await q(`SELECT id, kind FROM member_snapshots WHERE member_id=$1 AND proposal_id=$2`, [
      fund.members.M03,
      pid,
    ]);
    expect(snaps).toHaveLength(1);
    expect((snaps[0] as { kind: string }).kind).toBe('suspension');
  });
});
