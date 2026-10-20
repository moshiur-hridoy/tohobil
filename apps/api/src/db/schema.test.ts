import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_CODES, PROPOSAL_TYPES } from '@barakah/shared';
import { createTestDb, type TestDb } from '../test/db-harness';
import { verifyLedgerChainFromDb } from '../lib/ledger-chain';

/**
 * Schema, trigger and view tests against a real Postgres (spec 14.3: Ledger, Payments, Dues).
 * They skip (with a warning) when neither TEST_DATABASE_URL nor Docker is available.
 */

let db: TestDb | null = null;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/** Registers a test that is skipped when no database could be started. */
function dbTest(name: string, fn: (db: TestDb) => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn(db);
  });
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

let counter = 0;

async function newMember(pool: pg.Pool): Promise<string> {
  counter += 1;
  const code = `M${String(counter).padStart(2, '0')}`;
  const phone = `+88017${String(10_000_000 + counter)}`;
  const { rows } = await pool.query(
    `INSERT INTO members (code, full_name, phone, joined_on) VALUES ($1, $2, $3, '2026-01-01') RETURNING id`,
    [code, `Member ${code}`, phone],
  );
  return rows[0].id as string;
}

async function newDue(
  pool: pg.Pool,
  memberId: string,
  opts: { period?: string; amount?: number; dueDate?: string; kind?: string } = {},
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
     VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`,
    [
      memberId,
      opts.period ?? '2026-01',
      opts.kind ?? 'monthly',
      opts.amount ?? 500_000,
      opts.dueDate ?? '2026-01-20',
    ],
  );
  return rows[0].id as string;
}

async function newPayment(
  pool: pg.Pool,
  memberId: string,
  opts: { amount?: number; paidAt?: string; status?: string; trx?: string | null } = {},
): Promise<string> {
  const status = opts.status ?? 'confirmed';
  const confirmed = status === 'confirmed' || status === 'reversed';
  const { rows } = await pool.query(
    `INSERT INTO payments (member_id, amount_paisa, method, trx_id, paid_at, status, source, confirmed_at, reject_reason)
     VALUES ($1, $2, 'cash', $3, $4, $5, 'cashier_entry', $6, $7) RETURNING id`,
    [
      memberId,
      opts.amount ?? 500_000,
      opts.trx ?? null,
      opts.paidAt ?? '2026-01-10T10:00:00+06:00',
      status,
      confirmed ? new Date().toISOString() : null,
      status === 'rejected' ? 'wrong amount' : null,
    ],
  );
  return rows[0].id as string;
}

async function allocate(
  pool: pg.Pool,
  paymentId: string,
  target: { dueId?: string; fineId?: string },
  amount: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO payment_allocations (payment_id, due_id, fine_id, amount_paisa) VALUES ($1, $2, $3, $4)`,
    [paymentId, target.dueId ?? null, target.fineId ?? null, amount],
  );
}

async function post(
  pool: pg.Pool | pg.PoolClient,
  opts: { date?: string; debit?: string; credit?: string; amount?: number; memo?: string } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, memo)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      opts.date ?? '2026-01-05',
      opts.debit ?? 'CASH',
      opts.credit ?? 'MEMBER_CAPITAL',
      opts.amount ?? 100,
      opts.memo ?? 'test',
    ],
  );
}

async function dueStatus(
  pool: pg.Pool,
  dueId: string,
): Promise<{ status: string; outstanding: string }> {
  const { rows } = await pool.query(
    `SELECT status, outstanding_paisa::text AS outstanding FROM v_due_status WHERE due_id = $1`,
    [dueId],
  );
  return rows[0] as { status: string; outstanding: string };
}

// ---------------------------------------------------------------------------------------------

describe('baseline schema (migration applies to an empty database)', () => {
  dbTest(
    'seeds every account and proposal type the shared package knows about',
    async ({ admin }) => {
      const accounts = await admin.query('SELECT code FROM accounts');
      expect(accounts.rows.map((r) => r.code as string).sort()).toEqual([...ACCOUNT_CODES].sort());

      const policies = await admin.query('SELECT type FROM proposal_policies');
      expect(policies.rows.map((r) => r.type as string).sort()).toEqual([...PROPOSAL_TYPES].sort());
    },
  );

  dbTest(
    'big expenses switch to share-weighted voting at the threshold (18.3)',
    async ({ admin }) => {
      const { rows } = await admin.query(
        `SELECT basis, amount_threshold_paisa::text AS t FROM proposal_policies WHERE type = 'expense'`,
      );
      expect(rows[0]).toEqual({ basis: 'member', t: '10000000' });
    },
  );

  dbTest('get_rule returns the value in force on a date, or null before any', async ({ admin }) => {
    const fine = await admin.query(`SELECT get_rule('fine_per_share_paisa', '2026-06-01') AS v`);
    expect(fine.rows[0].v).toBe(50000);
    const before = await admin.query(`SELECT get_rule('due_day', '2025-01-01') AS v`);
    expect(before.rows[0].v).toBeNull();

    // A later rule row applies only from its valid_from (append-only, never edited).
    await admin.query(
      `INSERT INTO rules (key, value, valid_from) VALUES ('monthly_due_per_share_paisa', '600000', '2027-01-01')`,
    );
    const jan26 = await admin.query(
      `SELECT get_rule('monthly_due_per_share_paisa', '2026-12-31') AS v`,
    );
    const jan27 = await admin.query(
      `SELECT get_rule('monthly_due_per_share_paisa', '2027-01-01') AS v`,
    );
    expect([jan26.rows[0].v, jan27.rows[0].v]).toEqual([500000, 600000]);
  });

  dbTest('SMS is off by default (19.1) and OTP storage is gone', async ({ admin }) => {
    const sms = await admin.query(`SELECT value FROM settings WHERE key = 'sms_enabled'`);
    expect(sms.rows[0].value).toBe(false);
    const otp = await admin.query(`SELECT to_regclass('public.otp_codes') AS t`);
    expect(otp.rows[0].t).toBeNull();
  });

  dbTest('shares_on honours effective_from and effective_to', async ({ admin }) => {
    const m = await newMember(admin);
    await admin.query(
      `INSERT INTO share_holdings (member_id, shares, effective_from, effective_to, source)
       VALUES ($1, 2, '2026-01-01', '2026-03-01', 'initial')`,
      [m],
    );
    const q = (d: string) => admin.query(`SELECT shares_on($1, $2::date) AS s`, [m, d]);
    expect((await q('2025-12-31')).rows[0].s).toBe(0);
    expect((await q('2026-01-01')).rows[0].s).toBe(2);
    expect((await q('2026-02-28')).rows[0].s).toBe(2);
    expect((await q('2026-03-01')).rows[0].s).toBe(0); // effective_to is exclusive
  });

  dbTest('rejects malformed phone numbers and member codes', async ({ admin }) => {
    await expect(
      admin.query(
        `INSERT INTO members (code, full_name, phone, joined_on) VALUES ('M90','x','+8801212345678','2026-01-01')`,
      ),
    ).rejects.toThrow(/members_phone_check/);
    await expect(
      admin.query(
        `INSERT INTO members (code, full_name, phone, joined_on) VALUES ('M1','x','+8801712345678','2026-01-01')`,
      ),
    ).rejects.toThrow(/members_code_check/);
  });
});

describe('ledger', () => {
  dbTest(
    'every posting extends a hash chain that the TypeScript verifier reproduces',
    async ({ admin }) => {
      await post(admin, { memo: 'a' });
      await post(admin, { memo: 'b', amount: 250, debit: 'BANK', credit: 'RENT_INCOME' });
      await post(admin, { memo: 'ünïcödé | pipe', date: '2026-02-01' });
      const result = await verifyLedgerChainFromDb(admin);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(3);
    },
  );

  dbTest('the first row chains from 64 zeros', async ({ admin }) => {
    const { rows } = await admin.query(`SELECT prev_hash FROM ledger_entries ORDER BY seq LIMIT 1`);
    expect(rows[0].prev_hash).toBe('0'.repeat(64));
  });

  dbTest(
    'UPDATE, DELETE and TRUNCATE are rejected, even for the owning superuser',
    async ({ admin }) => {
      await post(admin, { memo: 'immutable' });
      await expect(admin.query(`UPDATE ledger_entries SET memo = 'edited'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(admin.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
      // Row triggers do not fire for TRUNCATE: this used to silently erase the whole ledger.
      // Postgres refuses a bare TRUNCATE of an FK-referenced table before any trigger runs; CASCADE (or
      // listing the referencing table) gets past that check, and then our statement trigger must stop it.
      await expect(admin.query(`TRUNCATE ledger_entries`)).rejects.toThrow(
        /append-only|referenced in a foreign key/,
      );
      await expect(admin.query(`TRUNCATE ledger_entries CASCADE`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`TRUNCATE ledger_entries, objections`)).rejects.toThrow(
        /append-only/,
      );
      await expect(admin.query(`TRUNCATE accounts CASCADE`)).rejects.toThrow(/append-only/);
    },
  );

  dbTest(
    'every append-only table rejects TRUNCATE; populated ones reject UPDATE and DELETE',
    async ({ admin }) => {
      const tables = [
        'audit_log',
        'payment_allocations',
        'member_snapshots',
        'asset_valuations',
        'rules',
        'member_status_events',
        'votes',
      ];
      for (const table of tables) {
        await expect(admin.query(`TRUNCATE ${table} CASCADE`), `truncate ${table}`).rejects.toThrow(
          /append-only/,
        );
      }

      // `rules` is seeded by the migration, so it already has rows to protect.
      await expect(admin.query(`UPDATE rules SET value = '1'`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM rules`)).rejects.toThrow(/append-only/);

      await admin.query(`INSERT INTO audit_log (action, entity_type) VALUES ('test', 'x')`);
      await expect(admin.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    },
  );

  dbTest('a multi-row INSERT chains row to row inside one statement', async ({ admin }) => {
    await admin.query(
      `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, memo)
       VALUES ('2026-01-06','CASH','MEMBER_CAPITAL',1,'m1'), ('2026-01-06','CASH','MEMBER_CAPITAL',2,'m2'),
              ('2026-01-06','CASH','MEMBER_CAPITAL',3,'m3')`,
    );
    expect((await verifyLedgerChainFromDb(admin)).ok).toBe(true);
  });

  dbTest('parallel postings keep the chain linear in seq order', async ({ admin }) => {
    // Before the BEFORE STATEMENT lock, ~2% of links broke under this load (seq was assigned before
    // the advisory lock, so commit order and seq order diverged).
    const workers = 12;
    const perWorker = 12;
    await Promise.all(
      Array.from({ length: workers }, async (_, w) => {
        for (let i = 0; i < perWorker; i++) {
          const client = await admin.connect();
          try {
            await client.query('BEGIN');
            await post(client, { memo: `w${w}-${i}` });
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        }
      }),
    );
    const result = await verifyLedgerChainFromDb(admin);
    expect(result.issues).toEqual([]);
    expect(result.count).toBeGreaterThanOrEqual(workers * perWorker);
  });

  dbTest('rejects postings in a locked period but not in open ones', async ({ admin }) => {
    await admin.query(`INSERT INTO periods (period, locked_at) VALUES ('2025-06', now())`);
    await expect(post(admin, { date: '2025-06-15' })).rejects.toThrow(/Period 2025-06 is locked/);
    await expect(post(admin, { date: '2025-07-15' })).resolves.toBeUndefined();
  });

  dbTest('FINE_INCOME is retired: fines post to CHARITY_PAYABLE (18.2)', async ({ admin }) => {
    await expect(post(admin, { credit: 'FINE_INCOME' })).rejects.toThrow(/FINE_INCOME is retired/);
    await expect(post(admin, { debit: 'FINE_INCOME', credit: 'BANK' })).rejects.toThrow(/retired/);
    await expect(
      post(admin, { credit: 'CHARITY_PAYABLE', memo: 'fine paid' }),
    ).resolves.toBeUndefined();
  });

  dbTest('rejects non-positive amounts and same-account entries', async ({ admin }) => {
    await expect(post(admin, { amount: 0 })).rejects.toThrow(/amount_paisa/);
    await expect(post(admin, { amount: -5 })).rejects.toThrow(/amount_paisa/);
    await expect(post(admin, { debit: 'CASH', credit: 'CASH' })).rejects.toThrow(/check/);
  });

  dbTest(
    'refuses to post under REPEATABLE READ (a stale snapshot would fork the chain)',
    async ({ admin }) => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await expect(post(client)).rejects.toThrow(/READ COMMITTED/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
  );

  dbTest('account balances: raw and natural signs', async ({ admin }) => {
    const before = await admin.query(
      `SELECT code, balance_paisa::text AS raw, natural_balance_paisa::text AS nat FROM v_account_balances
       WHERE code IN ('BKASH', 'SETTLEMENT_PAYABLE')`,
    );
    const get = (code: string) =>
      before.rows.find((r) => r.code === code) as { raw: string; nat: string };
    expect(get('BKASH')).toMatchObject({ raw: '0', nat: '0' });

    await post(admin, { debit: 'BKASH', credit: 'MEMBER_CAPITAL', amount: 7_000 });
    await post(admin, { debit: 'MEMBER_CAPITAL', credit: 'SETTLEMENT_PAYABLE', amount: 2_000 });
    const after = await admin.query(
      `SELECT code, balance_paisa::text AS raw, natural_balance_paisa::text AS nat FROM v_account_balances
       WHERE code IN ('BKASH', 'SETTLEMENT_PAYABLE')`,
    );
    const g = (code: string) =>
      after.rows.find((r) => r.code === code) as { raw: string; nat: string };
    expect(g('BKASH')).toEqual({ code: 'BKASH', raw: '7000', nat: '7000' }); // debit-normal asset
    // A liability: raw debit-minus-credit is negative, the natural balance is what the fund owes.
    expect(g('SETTLEMENT_PAYABLE')).toEqual({
      code: 'SETTLEMENT_PAYABLE',
      raw: '-2000',
      nat: '2000',
    });
  });

  it('tampering by a superuser is detected by the verifier', async (ctx) => {
    const isolated = await createTestDb();
    if (!isolated) return ctx.skip();
    try {
      for (let i = 1; i <= 5; i++)
        await post(isolated.admin, { memo: `row ${i}`, amount: i * 100 });
      expect((await verifyLedgerChainFromDb(isolated.admin)).ok).toBe(true);

      // A superuser can switch the protective trigger off and rewrite history...
      await isolated.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER no_mutation_ledger`);
      await isolated.admin.query(`UPDATE ledger_entries SET amount_paisa = 1 WHERE seq = 3`);
      await isolated.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER no_mutation_ledger`);

      // ...but the daily verifier catches it.
      const edited = await verifyLedgerChainFromDb(isolated.admin);
      expect(edited.ok).toBe(false);
      expect(edited.issues).toEqual([expect.objectContaining({ kind: 'hash' })]);
      expect(edited.issues[0]?.seq).toMatch(/^\d+$/);

      // Deleting a row is caught too (broken link at the following row).
      await isolated.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER no_mutation_ledger`);
      await isolated.admin.query(`DELETE FROM ledger_entries WHERE memo = 'row 2'`);
      await isolated.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER no_mutation_ledger`);
      const deleted = await verifyLedgerChainFromDb(isolated.admin);
      expect(deleted.issues.some((i) => i.kind === 'prev_hash')).toBe(true);
    } finally {
      await isolated.close();
    }
  });
});

describe('payments, dues and fines', () => {
  dbTest(
    'payment core fields are immutable; only legal status transitions pass',
    async ({ admin }) => {
      const m = await newMember(admin);
      const p = await newPayment(admin, m, { status: 'pending' });

      await expect(
        admin.query(`UPDATE payments SET amount_paisa = 1 WHERE id = $1`, [p]),
      ).rejects.toThrow(/immutable/);
      await expect(
        admin.query(`UPDATE payments SET method = 'bank' WHERE id = $1`, [p]),
      ).rejects.toThrow(/immutable/);
      await expect(
        admin.query(`UPDATE payments SET member_id = $2 WHERE id = $1`, [
          p,
          await newMember(admin),
        ]),
      ).rejects.toThrow(/immutable/);
      await expect(admin.query(`DELETE FROM payments WHERE id = $1`, [p])).rejects.toThrow(
        /cannot be deleted/,
      );

      // pending -> reversed is not a legal jump.
      await expect(
        admin.query(`UPDATE payments SET status = 'reversed', confirmed_at = now() WHERE id = $1`, [
          p,
        ]),
      ).rejects.toThrow(/illegal payment status transition/);

      await admin.query(
        `UPDATE payments SET status = 'confirmed', confirmed_at = now() WHERE id = $1`,
        [p],
      );
      await admin.query(`UPDATE payments SET status = 'reversed' WHERE id = $1`, [p]);
      await expect(
        admin.query(`UPDATE payments SET status = 'confirmed' WHERE id = $1`, [p]),
      ).rejects.toThrow(/illegal payment status transition/);
      await expect(admin.query(`TRUNCATE payments CASCADE`)).rejects.toThrow(/append-only/);
    },
  );

  dbTest('a rejection needs a reason of at least 3 characters (5.4)', async ({ admin }) => {
    const m = await newMember(admin);
    const p = await newPayment(admin, m, { status: 'pending' });
    await expect(
      admin.query(`UPDATE payments SET status = 'rejected', reject_reason = 'no' WHERE id = $1`, [
        p,
      ]),
    ).rejects.toThrow(/payments_check/);
    await expect(
      admin.query(
        `UPDATE payments SET status = 'rejected', reject_reason = 'wrong TrxID' WHERE id = $1`,
        [p],
      ),
    ).resolves.toBeDefined();
  });

  dbTest(
    'TrxID is unique ignoring case and whitespace, but a rejected TrxID can be resubmitted',
    async ({ admin }) => {
      const m = await newMember(admin);
      const first = await newPayment(admin, m, { status: 'pending', trx: ' ab12cd34ef ' });
      await expect(newPayment(admin, m, { status: 'pending', trx: 'AB12CD34EF' })).rejects.toThrow(
        /payments_trx_active/,
      );
      await expect(
        newPayment(admin, m, { status: 'confirmed', trx: 'Ab12Cd34Ef' }),
      ).rejects.toThrow(/payments_trx_active/);

      await admin.query(
        `UPDATE payments SET status = 'rejected', reject_reason = 'screenshot unclear' WHERE id = $1`,
        [first],
      );
      await expect(
        newPayment(admin, m, { status: 'pending', trx: 'AB12CD34EF' }),
      ).resolves.toBeDefined();
    },
  );

  dbTest(
    'a blank TrxID is rejected (it would collide with every other blank)',
    async ({ admin }) => {
      const m = await newMember(admin);
      await expect(newPayment(admin, m, { trx: '   ' })).rejects.toThrow(
        /payments_trx_id_check|payments_check/,
      );
    },
  );

  dbTest('one fine per due; late fines need a due; a waiver is set once', async ({ admin }) => {
    const m = await newMember(admin);
    const due = await newDue(admin, m);
    const { rows } = await admin.query(
      `INSERT INTO fines (due_id, member_id, amount_paisa) VALUES ($1, $2, 50000) RETURNING id`,
      [due, m],
    );
    const fine = rows[0].id as string;

    await expect(
      admin.query(`INSERT INTO fines (due_id, member_id, amount_paisa) VALUES ($1, $2, 50000)`, [
        due,
        m,
      ]),
    ).rejects.toThrow(/fines_one_per_due/);
    await expect(
      admin.query(`INSERT INTO fines (member_id, amount_paisa) VALUES ($1, 50000)`, [m]),
    ).rejects.toThrow(/fines_check/);

    await expect(
      admin.query(`UPDATE fines SET amount_paisa = 1 WHERE id = $1`, [fine]),
    ).rejects.toThrow(/immutable/);
    await expect(admin.query(`DELETE FROM fines WHERE id = $1`, [fine])).rejects.toThrow(
      /cannot be deleted/,
    );

    const proposal = (
      await admin.query(
        `INSERT INTO proposals (type, title, payload, created_by) VALUES ('fine_waiver','Waive','{}', $1) RETURNING id`,
        [m],
      )
    ).rows[0].id as string;
    await admin.query(`UPDATE fines SET waived_by_proposal = $2, waived_at = now() WHERE id = $1`, [
      fine,
      proposal,
    ]);
    await expect(
      admin.query(`UPDATE fines SET waived_at = now() + interval '1 day' WHERE id = $1`, [fine]),
    ).rejects.toThrow(/already waived/);

    const status = await admin.query(
      `SELECT outstanding_paisa::text AS o FROM v_fine_status WHERE fine_id = $1`,
      [fine],
    );
    expect(status.rows[0].o).toBe('0');
  });

  dbTest('dues are immutable and cannot be deleted', async ({ admin }) => {
    const m = await newMember(admin);
    const due = await newDue(admin, m);
    await expect(
      admin.query(`UPDATE dues SET amount_paisa = 1 WHERE id = $1`, [due]),
    ).rejects.toThrow(/append-only/);
    await expect(admin.query(`DELETE FROM dues WHERE id = $1`, [due])).rejects.toThrow(
      /append-only/,
    );
  });

  dbTest('allocations: bounds, ownership and payment state are enforced', async ({ admin }) => {
    const m = await newMember(admin);
    const other = await newMember(admin);
    const due = await newDue(admin, m, { amount: 600 });
    const payment = await newPayment(admin, m, { amount: 1000 });

    await expect(allocate(admin, payment, { dueId: due }, 700)).rejects.toThrow(/out of bounds/); // > due
    await allocate(admin, payment, { dueId: due }, 600);
    await expect(allocate(admin, payment, { dueId: due }, 1)).rejects.toThrow(/out of bounds/); // due full

    const due2 = await newDue(admin, m, { amount: 900, period: '2026-02', dueDate: '2026-02-20' });
    await expect(allocate(admin, payment, { dueId: due2 }, 401)).rejects.toThrow(/out of bounds/); // > payment
    await expect(allocate(admin, payment, { dueId: due2 }, 400)).resolves.toBeUndefined();

    const foreignDue = await newDue(admin, other);
    const p2 = await newPayment(admin, m, { amount: 500 });
    await expect(allocate(admin, p2, { dueId: foreignDue }, 100)).rejects.toThrow(
      /member mismatch/,
    );

    const pending = await newPayment(admin, m, { status: 'pending', amount: 500 });
    await expect(allocate(admin, pending, { dueId: due2 }, 100)).rejects.toThrow(
      /cannot allocate payment/,
    );

    await expect(admin.query(`UPDATE payment_allocations SET amount_paisa = 1`)).rejects.toThrow(
      /append-only/,
    );
  });

  dbTest('a negative reversal row restores the outstanding principal', async ({ admin }) => {
    const m = await newMember(admin);
    const due = await newDue(admin, m, { amount: 500_000, dueDate: '2020-01-20' });
    const payment = await newPayment(admin, m, { amount: 500_000 });

    expect(await dueStatus(admin, due)).toEqual({ status: 'overdue', outstanding: '500000' });
    await allocate(admin, payment, { dueId: due }, 500_000);
    expect((await dueStatus(admin, due)).outstanding).toBe('0');

    // The original view ignored negative rows, so a reversal never restored the debt.
    await allocate(admin, payment, { dueId: due }, -500_000);
    expect(await dueStatus(admin, due)).toEqual({ status: 'overdue', outstanding: '500000' });

    // The sum can never go below zero.
    await expect(allocate(admin, payment, { dueId: due }, -1)).rejects.toThrow(/out of bounds/);
  });

  dbTest(
    'derived due statuses: unpaid, partial, paid, overdue, paid_late (Asia/Dhaka dates)',
    async ({ admin }) => {
      const m = await newMember(admin);

      const future = await newDue(admin, m, { period: '2999-01', dueDate: '2999-01-20' });
      expect((await dueStatus(admin, future)).status).toBe('unpaid');

      const partialDue = await newDue(admin, m, {
        period: '2999-02',
        dueDate: '2999-02-20',
        amount: 1000,
      });
      await allocate(
        admin,
        await newPayment(admin, m, { amount: 400 }),
        { dueId: partialDue },
        400,
      );
      expect(await dueStatus(admin, partialDue)).toEqual({ status: 'partial', outstanding: '600' });

      // Paid at 23:59 Dhaka on the due date: on time.
      const onTime = await newDue(admin, m, { period: '2026-03', dueDate: '2026-03-20' });
      await allocate(
        admin,
        await newPayment(admin, m, { paidAt: '2026-03-20T23:59:00+06:00' }),
        { dueId: onTime },
        500_000,
      );
      expect((await dueStatus(admin, onTime)).status).toBe('paid');

      // Paid at 01:00 Dhaka the next day = 19:00 UTC on the due date. A UTC-based check calls this
      // "paid"; in Dhaka the member was one hour late.
      const late = await newDue(admin, m, { period: '2026-04', dueDate: '2026-04-20' });
      await allocate(
        admin,
        await newPayment(admin, m, { paidAt: '2026-04-21T01:00:00+06:00' }),
        { dueId: late },
        500_000,
      );
      expect((await dueStatus(admin, late)).status).toBe('paid_late');
    },
  );

  dbTest('concurrent confirmations cannot over-allocate the same due', async ({ admin }) => {
    const m = await newMember(admin);
    const due = await newDue(admin, m, { amount: 1000 });
    const p1 = await newPayment(admin, m, { amount: 1000 });
    const p2 = await newPayment(admin, m, { amount: 1000 });

    const run = async (paymentId: string): Promise<void> => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1, $2, 1000)`,
          [paymentId, due],
        );
        await new Promise((r) => setTimeout(r, 150)); // hold the transaction open so they truly overlap
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };

    const results = await Promise.allSettled([run(p1), run(p2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await dueStatus(admin, due)).outstanding).toBe('0');
  });
});

describe('roles, approvals and votes', () => {
  dbTest(
    'exactly one active cashier and one active auditor, never the same person',
    async ({ admin }) => {
      const [a, b, c] = [await newMember(admin), await newMember(admin), await newMember(admin)];
      const user = (m: string, roles: string, status = 'active') =>
        admin.query(
          `INSERT INTO users (member_id, roles, status) VALUES ($1, $2, $3) RETURNING id`,
          [m, roles, status],
        );

      const cashier = (await user(a, '{member,cashier}')).rows[0].id as string;
      await expect(user(b, '{member,cashier}')).rejects.toThrow(/users_one_active_cashier/);
      await user(b, '{member,auditor}');
      await expect(user(c, '{member,auditor}')).rejects.toThrow(/users_one_active_auditor/);
      await expect(user(c, '{member,cashier,auditor}')).rejects.toThrow(
        /users_cashier_not_auditor|users_one_active/,
      );

      // A disabled holder frees the seat (role change is a proposal; the old holder is disabled/stripped).
      await admin.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [cashier]);
      await expect(user(c, '{member,cashier}')).resolves.toBeDefined();
    },
  );

  dbTest('approvals and reconciliations enforce separation of duties', async ({ admin }) => {
    const [cashier, auditor] = [await newMember(admin), await newMember(admin)];
    const { rows } = await admin.query(
      `INSERT INTO approvals (kind, ref_id, requested_by) VALUES ('payment_reversal', 'x', $1) RETURNING id`,
      [cashier],
    );
    const id = rows[0].id as string;
    await expect(
      admin.query(
        `UPDATE approvals SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`,
        [id, cashier],
      ),
    ).rejects.toThrow(/approvals_check/);
    await expect(
      admin.query(
        `UPDATE approvals SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`,
        [id, auditor],
      ),
    ).resolves.toBeDefined();

    // A mismatch needs a note (5.12) and the cashier cannot approve their own reconciliation.
    await expect(
      admin.query(
        `INSERT INTO reconciliations (period, account, system_balance_paisa, actual_balance_paisa, submitted_by)
         VALUES ('2026-01', 'CASH', 1000, 900, $1)`,
        [cashier],
      ),
    ).rejects.toThrow(/reconciliations_check/);
    const rec = await admin.query(
      `INSERT INTO reconciliations (period, account, system_balance_paisa, actual_balance_paisa, note, submitted_by)
       VALUES ('2026-01', 'CASH', 1000, 900, 'counted twice', $1) RETURNING id`,
      [cashier],
    );
    await expect(
      admin.query(
        `UPDATE reconciliations SET approved_by = $2, approved_at = now() WHERE id = $1`,
        [rec.rows[0].id, cashier],
      ),
    ).rejects.toThrow(/reconciliations_check/);
  });

  dbTest(
    'votes are immutable except superseded_at; one current vote per member',
    async ({ admin }) => {
      const m = await newMember(admin);
      const proposal = (
        await admin.query(
          `INSERT INTO proposals (type, title, payload, created_by) VALUES ('general','Meet','{"text":"hi"}', $1) RETURNING id`,
          [m],
        )
      ).rows[0].id as string;
      const vote = (
        await admin.query(
          `INSERT INTO votes (proposal_id, member_id, choice) VALUES ($1, $2, 'yes') RETURNING id`,
          [proposal, m],
        )
      ).rows[0].id as string;

      await expect(
        admin.query(`INSERT INTO votes (proposal_id, member_id, choice) VALUES ($1, $2, 'no')`, [
          proposal,
          m,
        ]),
      ).rejects.toThrow(/votes_current/);
      await expect(
        admin.query(`UPDATE votes SET choice = 'no' WHERE id = $1`, [vote]),
      ).rejects.toThrow(/immutable/);
      await expect(admin.query(`DELETE FROM votes WHERE id = $1`, [vote])).rejects.toThrow(
        /append-only/,
      );

      await admin.query(`UPDATE votes SET superseded_at = now() WHERE id = $1`, [vote]);
      await admin.query(
        `INSERT INTO votes (proposal_id, member_id, choice) VALUES ($1, $2, 'no')`,
        [proposal, m],
      );
      await expect(
        admin.query(`UPDATE votes SET superseded_at = NULL WHERE id = $1`, [vote]),
      ).rejects.toThrow(/immutable/);
    },
  );

  dbTest('proposal types must have a policy', async ({ admin }) => {
    const m = await newMember(admin);
    await expect(
      admin.query(
        `INSERT INTO proposals (type, title, payload, created_by) VALUES ('made_up','x','{}', $1)`,
        [m],
      ),
    ).rejects.toThrow(/proposals_type_fkey/);
  });

  dbTest('idempotency keys are scoped per user', async ({ admin }) => {
    const [u1, u2] = [await newMember(admin), await newMember(admin)];
    const put = (user: string) =>
      admin.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash, response) VALUES ($1, 'k1', 'h', '{}')`,
        [user],
      );
    await put(u1);
    await expect(put(u2)).resolves.toBeDefined(); // another user's identical key must not collide or replay
    await expect(put(u1)).rejects.toThrow(/idempotency_keys_pkey/);
  });
});

describe('database roles (spec 6: migrator / app / readonly)', () => {
  dbTest(
    'the app role can read and post, but cannot rewrite or delete financial records',
    async ({ admin, app }) => {
      await expect(post(app, { memo: 'posted by the API' })).resolves.toBeUndefined();
      await expect(app.query(`UPDATE ledger_entries SET memo = 'x'`)).rejects.toThrow(
        /permission denied|append-only/,
      );
      await expect(app.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE ledger_entries`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM payments`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE rules SET value = '1'`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DROP TABLE ledger_entries`)).rejects.toThrow(/must be owner/);
      expect((await verifyLedgerChainFromDb(admin)).ok).toBe(true);
    },
  );

  dbTest(
    'the app role can allocate payments (row locks in the trigger need UPDATE rights)',
    async ({ admin, app }) => {
      const m = await newMember(admin);
      const due = await newDue(admin, m, { amount: 100 });
      const payment = await newPayment(admin, m, { amount: 100 });
      await expect(allocate(app, payment, { dueId: due }, 100)).resolves.toBeUndefined();
    },
  );

  dbTest(
    'the read-only role can verify the ledger but cannot write or read credentials',
    async ({ readonly }) => {
      expect((await verifyLedgerChainFromDb(readonly)).ok).toBe(true);
      await expect(post(readonly)).rejects.toThrow(/permission denied/);
      await expect(readonly.query(`SELECT * FROM users`)).rejects.toThrow(/permission denied/);
      await expect(readonly.query(`SELECT * FROM devices`)).rejects.toThrow(/permission denied/);
      await expect(readonly.query(`SELECT * FROM activation_codes`)).rejects.toThrow(
        /permission denied/,
      );
    },
  );
});
