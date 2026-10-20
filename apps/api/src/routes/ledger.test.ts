import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { autoChargePosting, ribaReceivedPosting } from '../ledger/postings';
import { postEntries, reverseEntry, type PostedEntry, type PostingInput } from '../ledger/service';
import { inTransaction } from '../lib/tx';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateAndLogin, seedFund, testEnv, type Fund } from '../test/fund-fixture';

const clock = createFakeClock(new Date('2026-11-05T03:00:00Z'));

const get = (app: FastifyInstance, url: string, token?: string) =>
  app.inject({
    url: `/api/v1${url}`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

const entry = (over: Partial<PostingInput>): PostingInput => ({
  entry_date: '2026-10-05',
  debit: 'CASH',
  credit: 'MEMBER_CAPITAL',
  amount_paisa: 100_000n,
  ref_type: 'payment',
  ref_id: randomUUID(),
  ...over,
});

describe('GET /ledger', () => {
  let db: TestDb | null;
  let app: FastifyInstance;
  let fund: Fund;
  let token: { M01: string; M02: string };
  const posted: PostedEntry[] = [];
  let reversal: PostedEntry;
  const P1 = randomUUID();
  const P2 = randomUUID();

  const post = async (entries: PostingInput[]) => {
    const out = await inTransaction(db!.app, (tx) =>
      postEntries(tx, entries, { userId: fund.users.M01 }),
    );
    posted.push(...out);
    return out;
  };

  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    token = {
      M01: await activateAndLogin(app, db, clock, fund, 'M01'),
      M02: await activateAndLogin(app, db, clock, fund, 'M02'),
    };

    await post([
      entry({
        entry_date: '2026-10-05',
        amount_paisa: 500_000n,
        member_id: fund.members.M03,
        ref_id: P1,
      }),
    ]);
    await post([
      entry({
        entry_date: '2026-10-06',
        debit: 'BKASH',
        amount_paisa: 1_000_000n,
        member_id: fund.members.M02,
        ref_id: P2,
      }),
    ]);
    await post([ribaReceivedPosting({ entryDate: '2026-10-07', amountPaisa: 4_200n })]);
    await post([
      autoChargePosting({
        entryDate: '2026-11-01',
        charge: 'BANK_CHARGE',
        paidFrom: 'BANK',
        amountPaisa: 5_000n,
      }),
    ]);
    await post([
      entry({
        entry_date: '2026-11-02',
        amount_paisa: 300_000n,
        member_id: fund.members.M03,
        ref_id: P1,
      }),
    ]);
    // The BKASH entry (#2) was a mistake.
    reversal = await inTransaction(db.app, (tx) =>
      reverseEntry(tx, posted[1]!.seq, {
        reason: 'wrong member',
        actor: { userId: fund.users.M01 },
        clock,
      }),
    );
    posted.push(reversal);

    // Open objection on #1, resolved objection on #5.
    await db.admin.query(
      `INSERT INTO objections (ledger_seq, member_id, text) VALUES ($1, $2, 'amount looks wrong')`,
      [posted[0]!.seq.toString(), fund.members.M02],
    );
    await db.admin.query(
      `INSERT INTO objections (ledger_seq, member_id, text, status, resolution, resolved_by, resolved_at)
       VALUES ($1, $2, 'duplicate?', 'resolved', 'checked, fine', $3, now())`,
      [posted[4]!.seq.toString(), fund.members.M02, fund.users.M07],
    );
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

  type Row = Record<string, unknown> & { seq: string };
  const list = async (qs = '', who = token.M02) => {
    const res = await get(app, `/ledger${qs}`, who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: Row[]; next_cursor: string | null };
  };

  dbIt('needs a logged-in user', async () => {
    expect((await get(app, '/ledger')).statusCode).toBe(401);
    expect((await get(app, '/ledger/verify')).statusCode).toBe(401);
  });

  dbIt(
    'is open to every member and lists newest first, with money as digit strings and the hash',
    async () => {
      const { items, next_cursor } = await list('?limit=200');
      expect(next_cursor).toBeNull();
      expect(items).toHaveLength(6);
      expect(items.map((i) => i.seq)).toEqual([...posted].reverse().map((p) => p.seq.toString()));
      const first = items.at(-1)!;
      expect(first).toMatchObject({
        entry_date: '2026-10-05',
        debit_account: 'CASH',
        credit_account: 'MEMBER_CAPITAL',
        amount_paisa: '500000',
        member_code: 'M03',
        ref_type: 'payment',
        ref_id: P1,
        posted_by_code: 'M01',
      });
      for (const row of items) {
        expect(row['hash']).toMatch(/^[0-9a-f]{64}$/);
        expect(row['amount_paisa']).toMatch(/^\d+$/);
      }
    },
  );

  dbIt('links an entry and its reversal both ways', async () => {
    const { items } = await list('?limit=200');
    const bySeq = Object.fromEntries(items.map((i) => [i.seq, i]));
    const original = bySeq[posted[1]!.seq.toString()]!;
    const rev = bySeq[reversal.seq.toString()]!;
    expect(original).toMatchObject({
      reversed_by_seq: reversal.seq.toString(),
      reverses_seq: null,
    });
    expect(rev).toMatchObject({
      reverses_seq: posted[1]!.seq.toString(),
      reversed_by_seq: null,
      debit_account: 'MEMBER_CAPITAL',
      credit_account: 'BKASH',
      ref_type: 'payment_reversal',
    });
    expect(rev['memo']).toBe(`Reversal of #${posted[1]!.seq}: wrong member`);
  });

  dbIt('shows an objection badge for open objections only', async () => {
    const { items } = await list('?limit=200');
    const badge = (n: number) =>
      items.find((i) => i.seq === posted[n]!.seq.toString())!['open_objections'];
    expect(badge(0)).toBe(1);
    expect(badge(4)).toBe(0); // resolved
    expect(badge(2)).toBe(0);
  });

  dbIt(
    'filters by date range, either side of an account, member, reference type and reference id',
    async () => {
      const seqs = async (qs: string) =>
        (await list(`?limit=200&order=asc&${qs}`)).items.map((i) => i.seq);
      const s = (...n: number[]) => n.map((i) => posted[i]!.seq.toString());

      // The reversal (#6) is dated like the entry it cancels, so it sits in October with it.
      expect(await seqs('from=2026-10-06&to=2026-10-07')).toEqual(s(1, 2, 5));
      expect(await seqs('from=2026-11-01')).toEqual(s(3, 4));
      expect(await seqs('to=2026-10-05')).toEqual(s(0));
      expect(await seqs('account=BKASH')).toEqual(s(1, 5)); // debit of #2, credit of its reversal
      expect(await seqs('account=CHARITY_PAYABLE')).toEqual(s(2));
      expect(await seqs(`member_id=${fund.members.M03}`)).toEqual(s(0, 4));
      expect(await seqs('ref_type=auto_charge')).toEqual(s(3));
      expect(await seqs(`ref_id=${P1}`)).toEqual(s(0, 4));
      expect(await seqs(`ref_type=payment&member_id=${fund.members.M02}`)).toEqual(s(1));
      expect(await seqs('ref_type=nothing_like_this')).toEqual([]);
    },
  );

  dbIt('rejects invalid filters', async () => {
    for (const qs of [
      'account=PETTY_CASH',
      'from=2026-02-30',
      'member_id=abc',
      'ref_type=Bad-Type',
      'order=sideways',
      'limit=0',
      'limit=201',
    ]) {
      expect((await get(app, `/ledger?${qs}`, token.M02)).statusCode, qs).toBe(400);
    }
    expect((await get(app, '/ledger?cursor=garbage', token.M02)).json().code).toBe(
      'request.invalid_cursor',
    );
  });

  dbIt('pages newest first and oldest first without repeating or skipping a row', async () => {
    for (const order of ['desc', 'asc'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { items: Row[]; next_cursor: string | null } = await list(
          `?limit=4&order=${order}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        seen.push(...page.items.map((i) => i.seq));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor);
      const expected = posted.map((p) => p.seq.toString());
      expect(seen, order).toEqual(order === 'asc' ? expected : [...expected].reverse());
      expect(pages).toBe(2);
    }
  });

  dbIt('a page walk is not disturbed by entries posted while it is in progress', async () => {
    const first = await list('?limit=3');
    // New entries arrive between page 1 and page 2.
    await post([entry({ entry_date: '2026-11-04', amount_paisa: 1n })]);
    await post([entry({ entry_date: '2026-11-04', amount_paisa: 2n })]);
    const second = await list(`?limit=3&cursor=${encodeURIComponent(first.next_cursor!)}`);
    const ids = [...first.items, ...second.items].map((i) => i.seq);
    expect(new Set(ids).size).toBe(6);
    // Page 2 continues exactly where page 1 stopped.
    const oldSix = posted
      .slice(0, 6)
      .map((p) => p.seq.toString())
      .reverse();
    expect(ids).toEqual(oldSix);
  });

  dbIt('verifies the chain: ok, with the row count and the hash of the newest entry', async () => {
    const res = await get(app, '/ledger/verify', token.M02);
    expect(res.statusCode).toBe(200);
    const newest = (await list('?limit=1')).items[0]!;
    expect(res.json()).toEqual({
      ok: true,
      count: posted.length,
      last_seq: newest.seq,
      last_hash: newest['hash'],
      issues_total: 0,
      issues: [],
    });
  });
});

describe('GET /ledger/verify detects tampering', () => {
  let db: TestDb | null;
  let app: FastifyInstance;
  let fund: Fund;
  let token: string;

  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    token = await activateAndLogin(app, db, clock, fund, 'M02');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  const verify = async () => (await get(app, '/ledger/verify', token)).json();
  // A superuser can switch the protective trigger off; the verifier is what notices.
  const asSuperuser = async (sql: string) => {
    await db!.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER no_mutation_ledger`);
    try {
      await db!.admin.query(sql);
    } finally {
      await db!.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER no_mutation_ledger`);
    }
  };

  it('an empty ledger verifies', async (ctx) => {
    if (!db) return ctx.skip();
    expect(await verify()).toEqual({
      ok: true,
      count: 0,
      last_seq: null,
      last_hash: '0'.repeat(64),
      issues_total: 0,
      issues: [],
    });
  });

  it('flags an edited row, accepts it again when restored, and flags a deleted row', async (ctx) => {
    if (!db) return ctx.skip();
    for (let i = 1; i <= 5; i++) {
      await inTransaction(db.app, (tx) =>
        postEntries(tx, [entry({ amount_paisa: BigInt(i * 100), memo: `row ${i}` })], {
          userId: null,
        }),
      );
    }
    expect((await verify()).ok).toBe(true);

    await asSuperuser(`UPDATE ledger_entries SET amount_paisa = amount_paisa + 1 WHERE seq = 3`);
    expect(await verify()).toMatchObject({
      ok: false,
      count: 5,
      issues_total: 1,
      issues: [{ seq: '3', kind: 'hash' }],
    });

    await asSuperuser(`UPDATE ledger_entries SET amount_paisa = amount_paisa - 1 WHERE seq = 3`);
    expect((await verify()).ok).toBe(true);

    await asSuperuser(`DELETE FROM ledger_entries WHERE seq = 2`);
    const deleted = await verify();
    expect(deleted.ok).toBe(false);
    expect(deleted.issues).toContainEqual({ seq: '3', kind: 'prev_hash' });
  });

  it('is rate limited because it walks every row', async (ctx) => {
    if (!db) return ctx.skip();
    // Five calls so far on this app instance; the limit is six a minute.
    expect((await get(app, '/ledger/verify', token)).statusCode).toBe(200);
    const res = await get(app, '/ledger/verify', token);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('rate_limit.exceeded');
  });
});
