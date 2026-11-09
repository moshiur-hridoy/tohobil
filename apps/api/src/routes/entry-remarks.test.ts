import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { postEntries, type PostedEntry } from '../ledger/service';
import { verifyLedger } from '../ledger/queries';
import { inTransaction } from '../lib/tx';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateAndLogin, seedFund, testEnv, type Fund } from '../test/fund-fixture';

const clock = createFakeClock(new Date('2026-11-05T03:00:00Z'));

/** Remarks written afterwards on a ledger entry (ASSUMPTIONS 128). */
describe('ledger entry remarks', () => {
  let db: TestDb | null;
  let app: FastifyInstance;
  let fund: Fund;
  let token: { M01: string; M02: string; M03: string; M07: string };
  let entry: PostedEntry;

  const call = (method: 'GET' | 'POST', url: string, who: string, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${who}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  beforeAll(async () => {
    db = await createTestDb({ cashByMethod: true });
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    token = {
      M01: await activateAndLogin(app, db, clock, fund, 'M01'),
      M02: await activateAndLogin(app, db, clock, fund, 'M02'),
      M03: await activateAndLogin(app, db, clock, fund, 'M03'),
      M07: await activateAndLogin(app, db, clock, fund, 'M07'),
    };
    [entry] = await inTransaction(db.app, (tx) =>
      postEntries(
        tx,
        [{ entry_date: '2026-10-05', debit: 'CASH', credit: 'MEMBER_CAPITAL', amount_paisa: 100_000n, member_id: fund.members.M03, ref_type: 'payment', ref_id: randomUUID() }],
        { userId: fund.users.M01 },
      ),
    ) as [PostedEntry];
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

  const seq = () => entry.seq.toString();
  const ledgerRow = async (who: string) =>
    ((await call('GET', '/ledger', who)).json() as { items: Array<Record<string, unknown>> }).items.find((r) => r['seq'] === seq())!;

  dbIt('only the cashier or the auditor can add one', async () => {
    const res = await call('POST', `/ledger/${seq()}/remarks`, token.M02, { text: 'not mine' });
    expect(res.statusCode).toBe(403);
    expect((await call('POST', '/ledger/999999/remarks', token.M01, { text: 'x' })).statusCode).toBe(404);
    expect((await call('POST', `/ledger/${seq()}/remarks`, token.M01, { text: '   ' })).statusCode).toBe(400);
  });

  dbIt('a newer remark replaces the shown one, the older stays in the history', async () => {
    expect((await call('POST', `/ledger/${seq()}/remarks`, token.M01, { text: 'first try' })).statusCode).toBe(201);
    clock.advance(60_000);
    expect((await call('POST', `/ledger/${seq()}/remarks`, token.M07, { text: 'paid in front of the imam' })).statusCode).toBe(201);

    const history = (await call('GET', `/ledger/${seq()}/remarks`, token.M01)).json() as { items: Array<{ text: string; by_code: string }> };
    expect(history.items.map((r) => r.text)).toEqual(['paid in front of the imam', 'first try']);
    expect(history.items[0]!.by_code).toBe('M07');

    const row = await ledgerRow(token.M01);
    expect(row['remark']).toBe('paid in front of the imam');
    expect(row['remark_count']).toBe(2);

    const audit = await db!.admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ledger.remark' AND entity_id = $1`, [seq()]);
    expect((audit.rows[0] as { n: number }).n).toBe(2);
  });

  dbIt('the entry\'s own member sees it; other members do not', async () => {
    expect((await ledgerRow(token.M03))['remark']).toBe('paid in front of the imam');
    expect((await call('GET', `/ledger/${seq()}/remarks`, token.M03)).statusCode).toBe(200);

    const other = await ledgerRow(token.M02);
    expect(other['remark']).toBeNull();
    expect(other['remark_count']).toBe(0);
    expect((await call('GET', `/ledger/${seq()}/remarks`, token.M02)).statusCode).toBe(403);
  });

  dbIt('remarks cannot be changed or deleted, and the hash chain is untouched', async () => {
    await expect(db!.app.query(`UPDATE entry_remarks SET text = 'changed'`)).rejects.toThrow();
    await expect(db!.app.query(`DELETE FROM entry_remarks`)).rejects.toThrow();
    await expect(db!.admin.query(`UPDATE entry_remarks SET text = 'changed'`)).rejects.toThrow(/append-only/);
    expect((await verifyLedger(db!.app)).ok).toBe(true);
  });
});
