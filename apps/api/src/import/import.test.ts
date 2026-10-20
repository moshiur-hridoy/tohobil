import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RAW_TABS, convertSheet, reviewCsv, type RawTabs } from './convert';
import { ImportError, parseDataset, readDataset } from './dataset';
import { assertSafeTarget, loadDataset } from './load';
import { FILES, type Dataset } from './schemas';
import { verifyImport } from './verify';
import { createTestDb, type TestDb } from '../test/db-harness';

const FIXTURES = fileURLToPath(new URL('../../../../scripts/import-sheet/fixtures/', import.meta.url));
const RAW = join(FIXTURES, 'raw');
const EXPECTED = join(FIXTURES, 'expected');

const rawTabs = (): RawTabs =>
  Object.fromEntries(
    (Object.entries(RAW_TABS) as Array<[keyof RawTabs, string]>).map(([k, f]) => [k, readFileSync(join(RAW, f), 'utf8')]),
  );

const expectedDataset = (): Dataset => readDataset(EXPECTED);
const clone = (ds: Dataset): Dataset => structuredClone(ds);

describe('sheet-to-csv (stage 1)', () => {
  it('turns the fixture tabs into exactly the checked-in normalized CSVs and review list', () => {
    const result = convertSheet(rawTabs());
    for (const name of Object.keys(FILES) as Array<keyof typeof FILES>) {
      const file = FILES[name].file;
      expect(result.files[name], file).toBe(readFileSync(join(EXPECTED, file), 'utf8'));
    }
    expect(reviewCsv(result.review)).toBe(readFileSync(join(EXPECTED, 'review.csv'), 'utf8'));
    expect(readdirSync(EXPECTED).sort()).toEqual([...Object.values(FILES).map((f) => f.file), 'review.csv'].sort());
  });

  it('the generated files validate against the zod schemas', () => {
    const ds = expectedDataset();
    expect(ds.members).toHaveLength(3);
    expect(ds.share_register).toHaveLength(4);
    expect(ds.payments).toHaveLength(9);
  });

  it('gold purchases default to BANK and are flagged; Profit, interest and the distribution are flagged', () => {
    const { review } = convertSheet(rawTabs());
    const ds = expectedDataset();
    expect(ds.assets.every((a) => a.source_account === 'BANK' && a.kind === 'gold')).toBe(true);
    expect(review.filter((r) => /source account of A0/.test(r.what))).toHaveLength(2);
    expect(review.some((r) => r.what === 'Profit row')).toBe(true);
    expect(ds.misc_ledger.find((e) => /Profit \(legacy/.test(e.memo))).toMatchObject({ debit_account: 'BANK', credit_account: 'OTHER_INCOME' });
    expect(ds.misc_ledger.find((e) => e.memo === 'Bank interest')).toMatchObject({ credit_account: 'CHARITY_PAYABLE' });
    expect(ds.misc_ledger.find((e) => e.memo === 'Profit distribution')).toMatchObject({ debit_account: 'DISTRIBUTIONS', amount_paisa: 200_000n });
    // fine totals and unlabelled scratch numbers are not imported
    expect(ds.misc_ledger.some((e) => /fine/i.test(e.memo) || /scratch/.test(e.memo))).toBe(false);
  });

  it('a due date that disagrees with the 20th and a Dashboard flag that disagrees are listed', () => {
    const { review } = convertSheet(rawTabs());
    expect(review.find((r) => r.what === 'due date of February')).toMatchObject({ suggested: '2026-02-20' });
    expect(review.find((r) => r.file === 'Dashboard.csv')?.what).toBe('Owner Two / March');
  });

  it('keeps a duplicate TrxID but lists it, and skips unknown payers instead of guessing', () => {
    const tabs = rawTabs();
    tabs.transaction = (tabs.transaction as string)
      .replace('OWN2FE0007', 'OWN1SB0001')
      .concat('11,Somebody Else,Cash,January,"৳1,000","৳1,000",৳0,Paid by hand\n');
    const result = convertSheet(tabs);
    expect(result.review.some((r) => /TrxID OWN1SB0001/.test(r.what))).toBe(true);
    expect(result.review.some((r) => /Somebody Else/.test(r.what))).toBe(true);
    expect(result.files.payments.match(/OWN1SB0001/g)?.length).toBeGreaterThanOrEqual(3); // trx column + SMS text, twice
  });

  it('survives garbage: unknown labels and statuses become review rows, never exceptions', () => {
    const result = convertSheet({
      collection: ',,Owner One\nMonth,Due,Status,Fine,Amount\nSomething,x,Paid,0,100\nJanuary,20 Jan 2026,Maybe,0,100\n',
      shareHolder: 'SL,Name\n1,A\n\nOwner,Shares\nOwner One,1\n',
    });
    expect(result.files.dues.trim().split('\n')).toHaveLength(1);
    expect(result.review.length).toBeGreaterThanOrEqual(2);
  });
});

describe('normalized CSV validation', () => {
  it('names every bad cell with file and row, in one error', () => {
    const texts = Object.fromEntries(Object.values(FILES).map((f) => [f.file, readFileSync(join(EXPECTED, f.file), 'utf8')]));
    texts['members.csv'] = (texts['members.csv'] as string).replace('+8801700000002', '12345');
    texts['payments.csv'] = (texts['payments.csv'] as string).replace(',bkash,OWN1SB0001', ',paypal,OWN1SB0001');
    let error: ImportError | undefined;
    try {
      parseDataset(texts);
    } catch (e) {
      error = e as ImportError;
    }
    expect(error).toBeInstanceOf(ImportError);
    expect(error?.problems.some((p) => p.startsWith('members.csv row 3: phone'))).toBe(true);
    expect(error?.problems.some((p) => p.startsWith('payments.csv row 2: method'))).toBe(true);
  });

  it('a missing required file is refused; allocations.csv may be absent', () => {
    const texts = Object.fromEntries(Object.values(FILES).map((f) => [f.file, readFileSync(join(EXPECTED, f.file), 'utf8')]));
    delete texts['allocations.csv'];
    expect(() => parseDataset(texts)).not.toThrow();
    delete texts['dues.csv'];
    expect(() => parseDataset(texts)).toThrow(/dues.csv: file is missing/);
  });
});

describe('target guard', () => {
  it('refuses a remote or production database unless told otherwise', () => {
    expect(() => assertSafeTarget('postgres://u:p@localhost:5432/x', 'development', false)).not.toThrow();
    expect(() => assertSafeTarget('postgres://u:p@db.example.com:5432/x', 'development', false)).toThrow(/Refusing/);
    expect(() => assertSafeTarget('postgres://u:p@localhost:5432/x', 'production', false)).toThrow(/Refusing/);
    expect(() => assertSafeTarget('postgres://u:p@db.example.com:5432/x', 'production', true)).not.toThrow();
  });
});

describe('load and verify (stages 2 and 3, real Postgres)', () => {
  const dbs: TestDb[] = [];
  const fresh = async (): Promise<TestDb | null> => {
    const db = await createTestDb();
    if (db) dbs.push(db);
    return db;
  };
  afterAll(async () => {
    await Promise.all(dbs.map((d) => d.close()));
  });

  const q = async (db: TestDb, sql: string) => (await db.admin.query(sql)).rows as Array<Record<string, string>>;
  const n = async (db: TestDb, table: string) => Number((await q(db, `SELECT count(*) AS n FROM ${table}`))[0]!['n']);

  it('dry run reports everything and writes nothing; bad input is refused whole', async (ctx) => {
    const db = await fresh();
    if (!db) return ctx.skip();
    const ds = expectedDataset();

    const report = await loadDataset(db.app, ds, { commit: false });
    expect(report.committed).toBe(false);
    expect(report.counts).toMatchObject({ members: 3, payments: 9, dues: 12, fines: 4, assets: 2 });
    expect(report.ledger_entries).toBeGreaterThan(10);
    for (const table of ['members', 'users', 'dues', 'fines', 'payments', 'payment_allocations', 'ledger_entries', 'assets', 'share_holdings', 'periods']) {
      expect(await n(db, table), table).toBe(0);
    }
    expect(await n(db, `audit_log WHERE action = 'import.load'`)).toBe(0);

    // a duplicate TrxID refuses the whole load and lists both payments
    const dup = clone(ds);
    dup.payments[1]!.trx_id = dup.payments[0]!.trx_id;
    await expect(loadDataset(db.app, dup, { commit: true })).rejects.toThrow(/Duplicate TrxID OWN1SB0001: payments P1 and P2/);
    expect(await n(db, 'payments')).toBe(0);

    // a member_key that does not exist, a waived fine, and an allocation to a closed period
    const unknown = clone(ds);
    unknown.payments[0]!.member_key = 'M09';
    await expect(loadDataset(db.app, unknown, { commit: true })).rejects.toThrow(/M09 is not in members.csv/);
    const waived = clone(ds);
    waived.fines[0]!.status = 'waived';
    await expect(loadDataset(db.app, waived, { commit: true })).rejects.toThrow(/waiver needs an executed fine_waiver proposal/);
    const badAlloc = clone(ds);
    badAlloc.allocations = [{ payment_key: 'P2', member_key: 'M01', period: '2026-01', kind: 'fine', amount_paisa: 1n }];
    await expect(loadDataset(db.app, badAlloc, { commit: true })).rejects.toThrow(/not open for M01/);
    expect(await n(db, 'members')).toBe(0);
  });

  it('commit loads through the posting service; verify passes on the clean fixture and the chain verifies', async (ctx) => {
    const db = await fresh();
    if (!db) return ctx.skip();
    const ds = expectedDataset();
    const report = await loadDataset(db.app, ds, { commit: true });
    expect(report.committed).toBe(true);
    expect(await n(db, 'members')).toBe(3);
    expect(await n(db, `payments WHERE source = 'import' AND status = 'confirmed'`)).toBe(9);
    expect(await n(db, `audit_log WHERE action = 'import.load'`)).toBe(1);

    const verdict = await verifyImport(db.readonly, ds);
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.members_checked).toBe(3);
    expect(verdict.ledger.count).toBe(report.ledger_entries);

    // every confirmed payment is fully accounted for in allocations and ledger
    expect(await q(db, `SELECT p.id FROM payments p WHERE p.amount_paisa <>
      (SELECT COALESCE(SUM(amount_paisa),0) FROM ledger_entries e WHERE e.ref_type='payment' AND e.ref_id=p.id)`)).toEqual([]);
    expect(await q(db, `SELECT p.id FROM payments p WHERE p.amount_paisa <>
      p.unallocated_paisa + (SELECT COALESCE(SUM(amount_paisa),0) FROM payment_allocations a WHERE a.payment_id=p.id)`)).toEqual([]);

    // fines went to charity (18.2), interest too; assets cost came out of BANK
    const net = async (account: string) =>
      BigInt((await q(db, `SELECT COALESCE(SUM(CASE WHEN debit_account='${account}' THEN amount_paisa ELSE -amount_paisa END),0)::text AS v
        FROM ledger_entries WHERE debit_account='${account}' OR credit_account='${account}'`))[0]!['v']!);
    expect(await net('CHARITY_PAYABLE')).toBe(-(150_000n + 30_000n)); // two paid fines plus the interest
    expect(await net('FINE_INCOME')).toBe(0n);
    expect(await net('INVESTMENTS_AT_COST')).toBe(5_000_000n);
    expect(await net('DISTRIBUTIONS')).toBe(200_000n);
    expect(await q(db, `SELECT 1 FROM ledger_entries WHERE ref_type = 'riba_received'`)).toHaveLength(1);
    // cash by account is exactly the sheet's balance after OPENING_ADJUSTMENT
    for (const o of ds.opening_balances) expect(await net(o.account), o.account).toBe(o.actual_balance_paisa);
    expect(report.opening_adjustments).toHaveLength(4);
    expect(verdict.opening_adjustments.length).toBeGreaterThan(0);

    // the importer is one-shot per database
    await expect(loadDataset(db.app, ds, { commit: true })).rejects.toThrow(/already holds imported payments/);
  });

  it('verification fails loudly on an injected mismatch', async (ctx) => {
    const db = await fresh();
    if (!db) return ctx.skip();
    const ds = expectedDataset();
    await loadDataset(db.app, ds, { commit: true });

    const wrongTotals = clone(ds);
    wrongTotals.expected_totals[0]!.principal_paid_paisa += 100_000n;
    const a = await verifyImport(db.readonly, wrongTotals);
    expect(a.ok).toBe(false);
    expect(a.failures).toEqual([expect.stringMatching(/^M01 principal_paid_paisa: sheet 3700000, system 3600000 \(difference -100000\)$/)]);

    const wrongCash = clone(ds);
    wrongCash.opening_balances[1]!.actual_balance_paisa += 5n;
    const b = await verifyImport(db.readonly, wrongCash);
    expect(b.failures).toEqual([expect.stringMatching(/^BANK balance: sheet 1200005, system 1200000/)]);

    const missing = clone(ds);
    missing.expected_totals.push({ ...ds.expected_totals[0]!, member_key: 'M08' });
    expect((await verifyImport(db.readonly, missing)).failures).toContain('M08: member is not in the database');

    // a tampered ledger (done as superuser) breaks the chain check
    await db.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ALL`);
    await db.admin.query(`UPDATE ledger_entries SET amount_paisa = amount_paisa + 1 WHERE seq = (SELECT min(seq) FROM ledger_entries)`);
    await db.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ALL`);
    const c = await verifyImport(db.readonly, ds);
    expect(c.ok).toBe(false);
    expect(c.failures.some((f) => /hash chain is broken/.test(f))).toBe(true);
  });

  it('allocations.csv overrides the default order; leftover credit pays later dues', async (ctx) => {
    const db = await fresh();
    if (!db) return ctx.skip();
    const ds = expectedDataset();

    // P3 spelled out by hand: same result as the default, written down explicitly
    ds.allocations = [
      { payment_key: 'P3', member_key: 'M01', period: '2026-02', kind: 'principal', amount_paisa: 1_000_000n },
      { payment_key: 'P3', member_key: 'M01', period: '2026-02', kind: 'fine', amount_paisa: 100_000n },
    ];
    // M02 pays March on 22 Feb: nothing is due yet, so it is credit until March exists
    ds.payments.find((p) => p.payment_key === 'P8')!.paid_at = '2026-02-22T10:00:00+06:00';

    const report = await loadDataset(db.app, ds, { commit: true });
    expect(report.warnings.some((w) => /was applied to open dues/.test(w))).toBe(true);
    expect((await verifyImport(db.readonly, ds)).failures).toEqual([]);
    expect(await q(db, `SELECT 1 FROM payments WHERE unallocated_paisa <> 0`)).toEqual([]);
  });
});
