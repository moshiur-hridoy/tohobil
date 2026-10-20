import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { generateDues } from '../dues/service';
import { postEntries } from '../ledger/service';
import { inTransaction } from '../lib/tx';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

const clock = createFakeClock(new Date('2026-11-05T03:00:00Z'));

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M03' | 'M07', TestSession>;
let seq: string;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    ...(who ? { headers: { authorization: `Bearer ${who}` } } : {}),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

describe('matrix and objections', () => {
  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    for (const code of ['M01', 'M02', 'M03', 'M07'] as const) {
      s[code] = await activateSession(app, db, clock, fund, code);
    }
    for (const period of ['2026-09', '2026-10', '2026-11']) {
      await generateDues({ pool: db.app, clock }, { period });
    }
    const [row] = await inTransaction(db.app, (tx) =>
      postEntries(
        tx,
        [{ entry_date: '2026-10-05', debit: 'CASH', credit: 'MEMBER_CAPITAL', amount_paisa: 1000n, ref_type: 'payment', member_id: fund.members.M03 }],
        { userId: fund.users.M01 },
      ),
    );
    seq = row!.seq.toString();
  });
  afterAll(async () => {
    await db?.close();
  });
  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  // ---- matrix -------------------------------------------------------------------------------

  dbIt('requires a login; defaults to the 12 periods ending this month, every member in code order', async () => {
    expect((await call('GET', '/matrix')).statusCode).toBe(401);
    const res = await call('GET', '/matrix', s.M02.access_token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.to).toBe('2026-11');
    expect(body.from).toBe('2025-12');
    expect(body.periods).toHaveLength(12);
    expect(body.members.map((m: { member_code: string }) => m.member_code)).toEqual(['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08']);
    // no due before the fund started: null cells, not zeros
    expect(body.members[0].cells['2025-12']).toBeNull();
  });

  dbIt('cells carry due, paid, fine and pending; totals add up per member and per period', async () => {
    // M03 (1 share): pay September in full, October partly; fine on November's due
    const dues = (await q(`SELECT id, period, amount_paisa::text AS amount FROM dues WHERE member_id=$1 ORDER BY period`, [fund.members.M03])) as Array<{ id: string; period: string; amount: string }>;
    const [sep, oct, nov] = dues;
    const pay = ((await q(
      `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, confirmed_at, unallocated_paisa)
       VALUES ($1, 800000, 'cash', '2026-09-10T06:00:00Z', 'confirmed', 'cashier_entry', '2026-09-10T06:00:00Z', 0) RETURNING id`,
      [fund.members.M03],
    )) as Array<{ id: string }>)[0]!.id;
    await q(`INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1,$2,$3)`, [pay, sep!.id, sep!.amount]);
    await q(`INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1,$2,$3)`, [pay, oct!.id, 300000]);
    await q(`INSERT INTO fines (due_id, member_id, amount_paisa) VALUES ($1,$2,50000)`, [nov!.id, fund.members.M03]);
    // a pending payment for M03 flags unpaid cells as "pending"
    await q(`INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source) VALUES ($1, 100, 'cash', now(), 'pending', 'member_submitted')`, [fund.members.M03]);

    const res = await call('GET', '/matrix?from=2026-09&to=2026-11', s.M02.access_token);
    const row = res.json().members.find((m: { member_code: string }) => m.member_code === 'M03');
    expect(row.cells['2026-09']).toMatchObject({ status: expect.stringMatching(/^paid/), due_paisa: sep!.amount, paid_paisa: sep!.amount, pending: false });
    expect(row.cells['2026-10']).toMatchObject({ paid_paisa: '300000', pending: true });
    expect(['partial', 'overdue']).toContain(row.cells['2026-10'].status);
    expect(row.cells['2026-11']).toMatchObject({ paid_paisa: '0', fine_paisa: '50000', fine_paid_paisa: '0' });

    const dueTotal = BigInt(sep!.amount) + BigInt(oct!.amount) + BigInt(nov!.amount);
    expect(row.totals).toMatchObject({ due_paisa: dueTotal.toString(), paid_paisa: (BigInt(sep!.amount) + 300000n).toString(), fine_paisa: '50000' });
    expect(BigInt(row.totals.outstanding_paisa)).toBe(dueTotal - BigInt(sep!.amount) - 300000n);

    // the column total of a period is the sum of the member cells
    const body = res.json();
    for (const period of body.periods as string[]) {
      const sum = (body.members as Array<{ cells: Record<string, { due_paisa: string } | null> }>).reduce(
        (a, m) => a + BigInt(m.cells[period]?.due_paisa ?? '0'),
        0n,
      );
      expect(body.totals_by_period[period].due_paisa).toBe(sum.toString());
    }
    // a waived fine does not show
    await q(`UPDATE fines SET waived_by_proposal = gen_random_uuid(), waived_at = now() WHERE member_id=$1`, [fund.members.M03]);
    const again = await call('GET', '/matrix?from=2026-11&to=2026-11', s.M02.access_token);
    expect(again.json().members.find((m: { member_code: string }) => m.member_code === 'M03').cells['2026-11'].fine_paisa).toBe('0');
  });

  dbIt('rejects an inverted range, a malformed period and more than 36 periods', async () => {
    expect((await call('GET', '/matrix?from=2026-11&to=2026-09', s.M02.access_token)).json().code).toBe('matrix.invalid_range');
    expect((await call('GET', '/matrix?from=2026-13', s.M02.access_token)).statusCode).toBe(400);
    expect((await call('GET', '/matrix?from=2020-01&to=2026-11', s.M02.access_token)).json().code).toBe('matrix.range_too_long');
  });

  // ---- objections ---------------------------------------------------------------------------

  dbIt('a member objects to a ledger row; the row shows an open-objection badge; no duplicate while open', async () => {
    const res = await call('POST', '/objections', s.M02.access_token, { ledger_seq: seq, text: 'I never paid this' });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const dup = await call('POST', '/objections', s.M02.access_token, { ledger_seq: seq, text: 'again' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'objection.already_open', objection_id: id });
    // someone else may still object to the same row
    expect((await call('POST', '/objections', s.M03.access_token, { ledger_seq: seq, text: 'me too' })).statusCode).toBe(201);

    const ledger = await call('GET', `/ledger?ref_type=payment&member_id=${fund.members.M03}`, s.M02.access_token);
    expect(JSON.stringify(ledger.json())).toMatch(/objection/);

    expect((await call('POST', '/objections', s.M02.access_token, { ledger_seq: '999999', text: 'no such row' })).json().code).toBe('ledger.entry_not_found');
    expect((await call('POST', '/objections', s.M02.access_token, { ledger_seq: seq, text: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/objections', undefined, { ledger_seq: seq, text: 'anonymous' })).statusCode).toBe(401);
  });

  dbIt('a read-only (suspended) member cannot object', async () => {
    await q(`UPDATE members SET status='suspended', suspended_on='2026-10-01' WHERE id=$1`, [fund.members.M02]);
    const res = await call('POST', '/objections', s.M02.access_token, { ledger_seq: seq, text: 'cannot do this' });
    expect(res.json().code).toBe('auth.read_only');
    await q(`UPDATE members SET status='active', suspended_on=NULL WHERE id=$1`, [fund.members.M02]);
  });

  dbIt('everyone can list; filters by status and row; only the auditor resolves, once, with a note', async () => {
    const open = await call('GET', `/objections?status=open&ledger_seq=${seq}`, s.M02.access_token);
    expect(open.json().items).toHaveLength(2);
    expect(open.json().items[0]).toMatchObject({ ledger_seq: seq, status: 'open', entry_amount_paisa: '1000' });
    const id = open.json().items[0].id as string;

    expect((await call('PATCH', `/objections/${id}`, s.M01.access_token, { status: 'resolved', resolution: 'cashier tries' })).statusCode).toBe(403);
    expect((await call('PATCH', `/objections/${id}`, s.M02.access_token, { status: 'resolved', resolution: 'member tries' })).statusCode).toBe(403);
    expect((await call('PATCH', `/objections/${id}`, s.M07.access_token, { status: 'resolved', resolution: 'ab' })).statusCode).toBe(400);
    const done = await call('PATCH', `/objections/${id}`, s.M07.access_token, { status: 'dismissed', resolution: 'Checked the SMS: the payment is real' });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('dismissed');
    expect((await call('PATCH', `/objections/${id}`, s.M07.access_token, { status: 'resolved', resolution: 'changing my mind' })).json().code).toBe('objection.already_decided');

    const stillOpen = await call('GET', `/objections?status=open&ledger_seq=${seq}`, s.M02.access_token);
    expect(stillOpen.json().items).toHaveLength(1);
    const closed = await call('GET', '/objections?status=dismissed', s.M02.access_token);
    expect(closed.json().items[0]).toMatchObject({ resolution: 'Checked the SMS: the payment is real', resolved_by_code: 'M07' });
    // after a dismissal the same member (the newest objection was M03's) may object again
    expect(closed.json().items[0].member_code).toBe('M03');
    expect((await call('POST', '/objections', s.M03.access_token, { ledger_seq: seq, text: 'new evidence now' })).statusCode).toBe(201);
  });

  dbIt('objection writes are audited and nothing can delete an objection', async () => {
    const actions = ((await q(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'objection.%'`)) as Array<{ action: string }>).map((r) => r.action);
    expect(actions.sort()).toEqual(['objection.create', 'objection.resolve']);
    await expect(db!.app.query(`DELETE FROM objections`)).rejects.toThrow();
  });
});
