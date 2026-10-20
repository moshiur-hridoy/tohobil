import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NAV_CASH_ACCOUNTS, NAV_DEDUCTION_ACCOUNTS, createFakeClock } from '@barakah/shared';
import { verifyLedgerChainFromDb } from '../lib/ledger-chain';
import { inTransaction } from '../lib/tx';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import { paymentPostings } from './postings';
import {
  postEntries,
  reverseEntry,
  reverseReference,
  type LedgerActor,
  type PostingInput,
} from './service';

const clock = createFakeClock(new Date('2026-11-05T03:00:00Z')); // 5 Nov 2026 in Dhaka

let db: TestDb | null;
let fund: Fund;
let actor: LedgerActor;

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  fund = await seedFund(db.admin);
  actor = { userId: fund.users.M01 };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

function dbIt(name: string, fn: (db: TestDb) => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn(db);
  });
}

const entry = (over: Partial<PostingInput> = {}): PostingInput => ({
  entry_date: '2026-11-03',
  debit: 'CASH',
  credit: 'MEMBER_CAPITAL',
  amount_paisa: 500_000n,
  member_id: null,
  ref_type: 'payment',
  ref_id: null,
  memo: 'test',
  ...over,
});

const post = (d: TestDb, entries: PostingInput[]) =>
  inTransaction(d.app, (tx) => postEntries(tx, entries, actor));

const reverse = (d: TestDb, seq: bigint, reason = 'entered by mistake') =>
  inTransaction(d.app, (tx) => reverseEntry(tx, seq, { reason, actor, clock }));

const count = async (d: TestDb) =>
  Number(
    ((await d.admin.query(`SELECT count(*) AS n FROM ledger_entries`)).rows[0] as { n: string }).n,
  );

const balances = async (d: TestDb) =>
  Object.fromEntries(
    (
      (await d.admin.query(`SELECT code, balance_paisa::text AS b FROM v_account_balances`))
        .rows as Array<{
        code: string;
        b: string;
      }>
    ).map((r) => [r.code, r.b]),
  );

const lock = (d: TestDb, period: string, locked: boolean) =>
  d.admin.query(
    `INSERT INTO periods (period, locked_at) VALUES ($1, CASE WHEN $2::boolean THEN now() END)
     ON CONFLICT (period) DO UPDATE SET locked_at = CASE WHEN $2::boolean THEN now() END`,
    [period, locked],
  );

describe('posting', () => {
  dbIt('posts a double-entry row and returns its seq, hash and the stored fields', async (d) => {
    const [posted] = await post(d, [
      entry({
        member_id: fund.members.M03,
        memo: 'principal',
        ref_id: fund.members.M03, // any uuid will do for the test
      }),
    ]);
    expect(typeof posted?.seq).toBe('bigint');
    expect(posted?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(posted).toMatchObject({
      entry_date: '2026-11-03',
      debit_account: 'CASH',
      credit_account: 'MEMBER_CAPITAL',
      amount_paisa: 500_000n,
      member_id: fund.members.M03,
      ref_type: 'payment',
      reverses_seq: null,
    });
    const row = (
      await d.admin.query(`SELECT created_by FROM ledger_entries WHERE seq = $1`, [
        posted?.seq.toString(),
      ])
    ).rows[0];
    expect(row).toEqual({ created_by: fund.users.M01 });
  });

  dbIt(
    'every posting extends one hash chain that the TypeScript verifier reproduces',
    async (d) => {
      await post(d, [
        entry({ memo: 'unicode ✓ | pipe | বাংলা' }),
        entry({ amount_paisa: 7n, debit: 'BANK' }),
      ]);
      const result = await verifyLedgerChainFromDb(d.readonly);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.count).toBeGreaterThanOrEqual(3);
    },
  );

  dbIt('rejects bad input with a stable code before touching the database', async (d) => {
    const before = await count(d);
    const cases: Array<[string, Partial<PostingInput>, string]> = [
      ['zero amount', { amount_paisa: 0n }, 'ledger.invalid_amount'],
      ['negative amount', { amount_paisa: -5n }, 'ledger.invalid_amount'],
      ['same account', { debit: 'CASH', credit: 'CASH' }, 'ledger.same_account'],
      ['unknown debit account', { debit: 'PETTY_CASH' }, 'ledger.unknown_account'],
      ['unknown credit account', { credit: 'NOPE' }, 'ledger.unknown_account'],
      ['retired FINE_INCOME (credit)', { credit: 'FINE_INCOME' }, 'ledger.retired_account'],
      [
        'retired FINE_INCOME (debit)',
        { debit: 'FINE_INCOME', credit: 'CASH' },
        'ledger.retired_account',
      ],
      ['impossible date', { entry_date: '2026-02-30' }, 'ledger.invalid_date'],
      ['date with time', { entry_date: '2026-02-03T10:00' }, 'ledger.invalid_date'],
      ['no reference type', { ref_type: '' }, 'ledger.invalid_ref_type'],
      ['upper-case reference type', { ref_type: 'Payment' }, 'ledger.invalid_ref_type'],
    ];
    for (const [name, over, code] of cases) {
      await expect(post(d, [entry(over)]), name).rejects.toMatchObject({ status: 400, code });
    }
    await expect(post(d, [])).rejects.toMatchObject({ code: 'ledger.nothing_to_post' });
    expect(await count(d)).toBe(before);
  });

  dbIt('a group is all or nothing: one bad entry rolls back the entries before it', async (d) => {
    await lock(d, '2026-05', true);
    const before = await count(d);
    await expect(
      post(d, [entry({ entry_date: '2026-11-03' }), entry({ entry_date: '2026-05-10' })]),
    ).rejects.toMatchObject({ status: 409, code: 'ledger.period_locked' });
    expect(await count(d)).toBe(before);
    await lock(d, '2026-05', false);
  });

  dbIt('refuses to post into a locked period and accepts it again once unlocked', async (d) => {
    await lock(d, '2026-06', true);
    await expect(post(d, [entry({ entry_date: '2026-06-15' })])).rejects.toMatchObject({
      code: 'ledger.period_locked',
      message: expect.stringContaining('2026-06') as string,
    });
    await lock(d, '2026-06', false);
    await expect(post(d, [entry({ entry_date: '2026-06-15' })])).resolves.toHaveLength(1);
  });

  dbIt(
    'the hash trigger demands READ COMMITTED, so a stale snapshot can never fork the chain',
    async (d) => {
      const client = await d.app.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await expect(postEntries(client, [entry()], actor)).rejects.toThrow(/READ COMMITTED/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
  );

  dbIt('parallel postings from many transactions keep the chain linear', async (d) => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        post(d, [entry({ amount_paisa: BigInt(i + 1), memo: `p${i}` })]),
      ),
    );
    const result = await verifyLedgerChainFromDb(d.admin);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('posting rules: fines are charity money (18.2)', () => {
  dbIt(
    'a fine part of a payment is posted to CHARITY_PAYABLE and the ledger accepts it',
    async (d) => {
      const entries = paymentPostings({
        entryDate: '2026-11-04',
        method: 'bkash',
        memberId: fund.members.M05,
        paymentId: fund.members.M05, // any uuid
        principalPaisa: 1_000_000n,
        creditPaisa: 250_000n,
        finePaisa: 150_000n,
      });
      const before = await balances(d);
      await post(d, entries);
      const after = await balances(d);
      const delta = (code: string) => BigInt(after[code] ?? '0') - BigInt(before[code] ?? '0');
      expect(delta('BKASH')).toBe(1_400_000n);
      expect(delta('MEMBER_CAPITAL')).toBe(-1_250_000n);
      expect(delta('CHARITY_PAYABLE')).toBe(-150_000n);
      expect(delta('FINE_INCOME')).toBe(0n);
    },
  );

  dbIt('the database refuses FINE_INCOME even if the service were bypassed', async (d) => {
    await expect(
      d.admin.query(
        `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa)
         VALUES ('2026-11-04', 'CASH', 'FINE_INCOME', 100)`,
      ),
    ).rejects.toThrow(/retired/);
  });
});

describe('reversal', () => {
  dbIt(
    'posts the mirror image, leaves the original untouched, and balances net to zero',
    async (d) => {
      const before = await balances(d);
      const [original] = await post(d, [
        entry({
          member_id: fund.members.M03,
          ref_id: fund.members.M06,
          memo: 'to be undone',
          amount_paisa: 123_456n,
        }),
      ]);
      const originalRow = (
        await d.admin.query(`SELECT * FROM ledger_entries WHERE seq = $1`, [
          original?.seq.toString(),
        ])
      ).rows[0];

      const reversal = await reverse(d, original!.seq, 'wrong member');
      expect(reversal).toMatchObject({
        debit_account: 'MEMBER_CAPITAL',
        credit_account: 'CASH',
        amount_paisa: 123_456n,
        member_id: fund.members.M03,
        ref_type: 'payment_reversal',
        ref_id: fund.members.M06,
        reverses_seq: original?.seq,
        memo: `Reversal of #${original?.seq}: wrong member`,
        entry_date: '2026-11-03',
      });
      expect(reversal.seq > original!.seq).toBe(true);

      // Nothing about the original changed, hash included.
      expect(
        (
          await d.admin.query(`SELECT * FROM ledger_entries WHERE seq = $1`, [
            original?.seq.toString(),
          ])
        ).rows[0],
      ).toEqual(originalRow);
      expect(await balances(d)).toEqual(before);
      expect((await verifyLedgerChainFromDb(d.admin)).ok).toBe(true);
    },
  );

  dbIt('writes an audit row naming the reversal and the reason', async (d) => {
    const [original] = await post(d, [entry()]);
    const reversal = await reverse(d, original!.seq, 'duplicate entry');
    const audit = await d.admin.query(
      `SELECT actor_user_id, after FROM audit_log WHERE action = 'ledger.reverse' AND entity_id = $1`,
      [original?.seq.toString()],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: fund.users.M01,
        after: {
          reversal_seq: reversal.seq.toString(),
          amount_paisa: '500000',
          entry_date: '2026-11-03',
          reason: 'duplicate entry',
        },
      },
    ]);
  });

  dbIt('an entry can be reversed once, even when two requests race', async (d) => {
    const [original] = await post(d, [entry()]);
    const results = await Promise.allSettled([
      reverse(d, original!.seq),
      reverse(d, original!.seq),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409, code: 'ledger.already_reversed' });
    await expect(reverse(d, original!.seq)).rejects.toMatchObject({
      code: 'ledger.already_reversed',
    });
    const n = await d.admin.query(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE reverses_seq = $1`,
      [original?.seq.toString()],
    );
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  dbIt(
    'a reversal cannot itself be reversed; unknown entries and missing reasons are refused',
    async (d) => {
      const [original] = await post(d, [entry()]);
      const reversal = await reverse(d, original!.seq);
      await expect(reverse(d, reversal.seq)).rejects.toMatchObject({
        status: 400,
        code: 'ledger.cannot_reverse_reversal',
      });
      await expect(reverse(d, 999_999_999n)).rejects.toMatchObject({
        status: 404,
        code: 'ledger.entry_not_found',
      });
      await expect(reverse(d, original!.seq, '  ab ')).rejects.toMatchObject({
        code: 'ledger.reason_required',
      });
    },
  );

  dbIt(
    'is dated like the original while its period is open, and today once that period is locked',
    async (d) => {
      const [oldEntry] = await post(d, [entry({ entry_date: '2026-03-10' })]);
      expect((await reverse(d, oldEntry!.seq)).entry_date).toBe('2026-03-10');

      const [lockedEntry] = await post(d, [entry({ entry_date: '2026-04-10' })]);
      await lock(d, '2026-04', true);
      const moved = await reverse(d, lockedEntry!.seq);
      expect(moved.entry_date).toBe('2026-11-05'); // today in Dhaka, the open period
      await lock(d, '2026-04', false);
    },
  );

  dbIt('fails when both the original period and the current period are locked', async (d) => {
    const [original] = await post(d, [entry({ entry_date: '2026-02-10' })]);
    await lock(d, '2026-02', true);
    await lock(d, '2026-11', true);
    try {
      await expect(reverse(d, original!.seq)).rejects.toMatchObject({
        status: 409,
        code: 'ledger.period_locked',
      });
    } finally {
      await lock(d, '2026-02', false);
      await lock(d, '2026-11', false);
    }
    const left = await d.admin.query(`SELECT 1 FROM ledger_entries WHERE reverses_seq = $1`, [
      original?.seq.toString(),
    ]);
    expect(left.rowCount).toBe(0);
  });

  dbIt(
    'reverses every entry of a reference, skips ones already reversed, and is repeatable',
    async (d) => {
      const paymentId = fund.members.M08; // any uuid
      const posted = await post(
        d,
        paymentPostings({
          entryDate: '2026-11-04',
          method: 'cash',
          memberId: fund.members.M08,
          paymentId,
          principalPaisa: 2_000_000n,
          creditPaisa: 100_000n,
          finePaisa: 200_000n,
        }),
      );
      expect(posted).toHaveLength(3);
      const before = await balances(d);

      // One of the three is cancelled by hand first.
      await reverse(d, posted[1]!.seq, 'partial fix');
      const reversals = await inTransaction(d.app, (tx) =>
        reverseReference(tx, 'payment', paymentId, { reason: 'payment reversed', actor, clock }),
      );
      expect(reversals).toHaveLength(2);
      expect(
        reversals.every((r) => r.ref_type === 'payment_reversal' && r.ref_id === paymentId),
      ).toBe(true);

      const again = await inTransaction(d.app, (tx) =>
        reverseReference(tx, 'payment', paymentId, { reason: 'payment reversed', actor, clock }),
      );
      expect(again).toEqual([]);

      // `before` still includes the whole payment, so undoing it moves each account by its share.
      const after = await balances(d);
      const delta = (code: string) => BigInt(after[code] ?? '0') - BigInt(before[code] ?? '0');
      expect(delta('CASH')).toBe(-2_300_000n);
      expect(delta('MEMBER_CAPITAL')).toBe(2_100_000n);
      expect(delta('CHARITY_PAYABLE')).toBe(200_000n);
    },
  );

  dbIt('the database itself refuses a reversal that does not mirror its original', async (d) => {
    const [o] = await post(d, [entry({ member_id: fund.members.M03, amount_paisa: 1_000n })]);
    const direct = (over: Record<string, unknown>) => {
      const v = {
        debit: 'MEMBER_CAPITAL',
        credit: 'CASH',
        amount: 1_000,
        member: fund.members.M03,
        reverses: o?.seq.toString(),
        memo: `Reversal of #${o?.seq}: x`,
        ...over,
      };
      return d.admin.query(
        `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, memo, reverses_seq)
         VALUES ('2026-11-04', $1, $2, $3, $4, 'payment_reversal', $5, $6)`,
        [v.debit, v.credit, v.amount, v.member, v.memo, v.reverses],
      );
    };
    await expect(direct({ amount: 999 })).rejects.toThrow(/does not mirror/);
    await expect(direct({ debit: 'CASH', credit: 'MEMBER_CAPITAL' })).rejects.toThrow(
      /does not mirror/,
    );
    await expect(direct({ member: fund.members.M04 })).rejects.toThrow(/does not mirror/);
    await expect(direct({ memo: 'undo' })).rejects.toThrow(/check constraint/);
    await expect(direct({ memo: null })).rejects.toThrow(/check constraint/);
    // "#1:" must not be satisfiable by a memo for "#10:" (and vice versa).
    await expect(direct({ memo: `Reversal of #${o?.seq}0: x` })).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      direct({ reverses: '987654321', memo: 'Reversal of #987654321: x' }),
    ).rejects.toThrow(/does not exist/);

    await expect(direct({})).resolves.toBeDefined(); // the faithful mirror is fine...
    await expect(direct({})).rejects.toThrow(/ledger_one_reversal/); // ...but only once
  });

  dbIt('the chain still verifies after all of the above', async (d) => {
    const result = await verifyLedgerChainFromDb(d.readonly);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('NAV exclusions match the seeded chart of accounts', () => {
  dbIt(
    'every deduction is a liability and the cash accounts are exactly the cash ones',
    async (d) => {
      const kinds = Object.fromEntries(
        (
          (await d.admin.query(`SELECT code, kind, is_cash FROM accounts`)).rows as Array<{
            code: string;
            kind: string;
            is_cash: boolean;
          }>
        ).map((r) => [r.code, r]),
      );
      for (const code of NAV_DEDUCTION_ACCOUNTS) {
        expect(kinds[code]?.kind, code).toBe('liability');
        expect(kinds[code]?.is_cash, code).toBe(false);
      }
      const cash = Object.values(kinds)
        .filter((r) => r.is_cash)
        .map((r) => r.code)
        .sort();
      expect(cash).toEqual([...NAV_CASH_ACCOUNTS].sort());
      // Every liability account in the chart is deducted: a new one must be added to the list on purpose.
      const liabilities = Object.values(kinds)
        .filter((r) => r.kind === 'liability')
        .map((r) => r.code)
        .sort();
      expect(liabilities).toEqual([...NAV_DEDUCTION_ACCOUNTS].sort());
    },
  );
});

describe('the application role cannot rewrite or delete financial records', () => {
  const APPEND_ONLY = [
    'ledger_entries',
    'audit_log',
    'payment_allocations',
    'member_snapshots',
    'asset_valuations',
    'rules',
    'member_status_events',
    'device_events',
    'charity_donations',
  ];
  const NEVER_DELETED = [
    ...APPEND_ONLY,
    'payments',
    'dues',
    'fines',
    'files',
    'documents',
    'members',
    'share_holdings',
    'proposals',
    'votes',
    'objections',
    'approvals',
    'settlements',
    'settlement_payouts',
    'reconciliations',
    'rent_expected',
    'constitution_versions',
  ];
  const privilege = async (d: TestDb, table: string, kind: string) =>
    (
      (
        await d.admin.query(`SELECT has_table_privilege('barakah_app', $1, $2) AS ok`, [
          table,
          kind,
        ])
      ).rows[0] as { ok: boolean }
    ).ok;

  dbIt(
    'has no UPDATE on the append-only tables and no DELETE or TRUNCATE on any financial table',
    async (d) => {
      for (const t of APPEND_ONLY)
        expect(await privilege(d, t, 'UPDATE'), `UPDATE ${t}`).toBe(false);
      for (const t of NEVER_DELETED) {
        expect(await privilege(d, t, 'DELETE'), `DELETE ${t}`).toBe(false);
        expect(await privilege(d, t, 'TRUNCATE'), `TRUNCATE ${t}`).toBe(false);
      }
    },
  );

  dbIt(
    'real attempts on rows that exist are refused, including by triggers for tables it may touch',
    async (d) => {
      await post(d, [entry()]);
      await d.admin.query(`INSERT INTO audit_log (action, entity_type) VALUES ('probe', 'probe')`);
      await expect(d.app.query(`UPDATE ledger_entries SET amount_paisa = 1`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(d.app.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/permission denied/);
      await expect(d.app.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(d.app.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission denied/);
      await expect(d.app.query(`DELETE FROM files`)).rejects.toThrow(/permission denied/);

      // dues are UPDATE-able by privilege but a trigger makes them append-only for everyone.
      await d.admin.query(
        `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, '2026-11', 'monthly', 1, 500000, '2026-11-20')`,
        [fund.members.M03],
      );
      await expect(d.app.query(`UPDATE dues SET amount_paisa = 1`)).rejects.toThrow(/append-only/);
    },
  );
});
