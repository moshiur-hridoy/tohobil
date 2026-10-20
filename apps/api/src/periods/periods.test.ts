import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { parseEnv } from '../lib/env';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';
import { runLedgerVerify } from '../system/status';

const clock = createFakeClock(new Date('2027-01-05T04:00:00Z')); // 5 Jan 2027, 10:00 in Dhaka
const root = mkdtempSync(join(tmpdir(), 'barakah-p5-'));
const env = parseEnv({
  ...Object.fromEntries(Object.entries(testEnv).map(([k, v]) => [k, String(v)])),
  FILES_DIR: join(root, 'files'),
  ARCHIVES_DIR: join(root, 'archives'),
  STATUS_DIR: join(root, 'status'),
});

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const cashier = {} as TestSession;
const auditor = {} as TestSession;
const member = {} as TestSession;
const other = {} as TestSession;
const secrets = new Map<string, string>();

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

async function stepUp(s: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', s.access_token);
  secrets.set(s.device_id, (enrol.json() as { secret: string }).secret);
  const code = authenticator.clone({ epoch: clock.now().getTime() }).generate(secrets.get(s.device_id) as string);
  const res = await call('POST', '/auth/totp/verify', s.access_token, { code });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

const balances = async () => {
  const rows = await q(`SELECT code, balance_paisa::text AS b FROM v_account_balances WHERE code IN ('CASH','BANK','BKASH','NAGAD')`);
  return Object.fromEntries(rows.map((r) => [r.code as string, BigInt(r.b as string)]));
};

const count = (b: Record<string, bigint>, over: Record<string, bigint> = {}, note?: string) =>
  ['CASH', 'BANK', 'BKASH', 'NAGAD'].map((account) => ({
    account,
    actual_balance_paisa: String(over[account] ?? b[account] ?? 0n),
    ...(note && over[account] !== undefined ? { note } : {}),
  }));

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env, db: db.app, clock });
  fund = await seedFund(db.admin);
  Object.assign(cashier, await activateSession(app, db, clock, fund, 'M01'));
  Object.assign(auditor, await activateSession(app, db, clock, fund, 'M07'));
  Object.assign(member, await activateSession(app, db, clock, fund, 'M02'));
  Object.assign(other, await activateSession(app, db, clock, fund, 'M03'));
  await stepUp(cashier);
  await stepUp(auditor);
  // some history: opening cash, one confirmed monthly payment for M02 and an asset-free ledger
  await q(`INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, memo)
           VALUES ('2026-12-10','BANK','MEMBER_CAPITAL',2000000,$1,'import','opening'),
                  ('2026-12-12','CASH','MEMBER_CAPITAL',500000,$1,'import','cash dues')`, [fund.members.M02]);
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

describe('month-end cash count and period lock', () => {
  dbIt('a month cannot be counted before it ends', async () => {
    const res = await call('POST', '/reconciliations', cashier.access_token, { period: '2027-01', entries: count(await balances()) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('period.not_ended');
  });

  dbIt('a difference needs a note and alerts the auditor; the books figure is never supplied', async () => {
    const b = await balances();
    const noNote = await call('POST', '/reconciliations', cashier.access_token, {
      period: '2026-12',
      entries: count(b, { CASH: b.CASH! - 100n }),
    });
    expect(noNote.json().code).toBe('reconciliation.note_required');

    const ok = await call('POST', '/reconciliations', cashier.access_token, {
      period: '2026-12',
      entries: count(b, { CASH: b.CASH! - 100n }, 'one coin missing'),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().difference_paisa).toBe('-100');
    const rows = (await call('GET', '/reconciliations?period=2026-12', cashier.access_token)).json().items;
    expect(rows.find((r: { account: string }) => r.account === 'CASH')).toMatchObject({ difference_paisa: '-100', system_balance_paisa: b.CASH!.toString() });

    const alerts = await q(`SELECT n.payload FROM notifications n JOIN members m ON m.id = n.member_id WHERE m.code='M07' AND n.template='reconciliation_mismatch'`);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).toContain('CASH');

    // fix the count to match, resubmit before approval
    expect((await call('POST', '/reconciliations', cashier.access_token, { period: '2026-12', entries: count(b) })).json().difference_paisa).toBe('0');
  });

  dbIt('only the auditor approves, locking needs the approval, and a locked month refuses new entries', async () => {
    expect((await call('POST', '/reconciliations/2026-12/approve', cashier.access_token)).statusCode).toBe(403);
    expect((await call('POST', '/periods/2026-12/lock', auditor.access_token)).json().code).toBe('period.not_reconciled');

    expect((await call('POST', '/reconciliations/2026-12/approve', auditor.access_token)).statusCode).toBe(204);
    expect((await call('POST', '/reconciliations/2026-12/approve', auditor.access_token)).json().code).toBe('reconciliation.already_approved');
    // an approved month cannot be recounted
    expect((await call('POST', '/reconciliations', cashier.access_token, { period: '2026-12', entries: count(await balances()) })).json().code).toBe('reconciliation.already_approved');

    expect((await call('POST', '/periods/2026-12/lock', auditor.access_token)).statusCode).toBe(204);
    expect((await call('POST', '/periods/2026-12/lock', auditor.access_token)).json().code).toBe('period.already_locked');
    await expect(
      q(`INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, ref_type) VALUES ('2026-12-20','CASH','MEMBER_CAPITAL',1,'import')`),
    ).rejects.toThrow(/locked/i);
    const periods = (await call('GET', '/periods?year=2026', member.access_token)).json().items;
    expect(periods.find((p: { period: string }) => p.period === '2026-12').locked_at).toBeTruthy();
  });

  dbIt('an open objection in the month blocks the lock', async () => {
    const seq = (await q(`INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, ref_type, memo)
                          VALUES ('2026-11-03','BANK','MEMBER_CAPITAL',1000,'import','nov') RETURNING seq::text`))[0]!.seq as string;
    await q(`INSERT INTO objections (ledger_seq, member_id, text) VALUES ($1,$2,'looks wrong')`, [seq, fund.members.M02]);
    // as of 30 November the books hold only that one entry (the December entries come later)
    const november = { CASH: 0n, BANK: 1000n, BKASH: 0n, NAGAD: 0n };
    expect((await call('POST', '/reconciliations', cashier.access_token, { period: '2026-11', entries: count(november) })).statusCode).toBe(200);
    expect((await call('POST', '/reconciliations/2026-11/approve', auditor.access_token)).statusCode).toBe(204);
    const blocked = await call('POST', '/periods/2026-11/lock', auditor.access_token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('period.open_objections');
    await q(`UPDATE objections SET status='resolved' WHERE ledger_seq=$1`, [seq]).catch(() => undefined);
  });
});

describe('year end: audit sign-off and archive', () => {
  dbIt('the archive needs all twelve months locked and the auditor\'s signature, and is never overwritten', async () => {
    expect((await call('POST', '/periods/2026/audit-request', cashier.access_token)).json().code).toBe('year.not_locked');
    // eleven months locked by the book (their own counts are covered above); December went the full way
    for (let m = 1; m <= 11; m++) {
      await q(`INSERT INTO periods (period, locked_at) VALUES ($1, now()) ON CONFLICT (period) DO UPDATE SET locked_at = now()`, [`2026-${String(m).padStart(2, '0')}`]);
    }
    expect((await call('POST', '/periods/2026/archive', cashier.access_token)).json().code).toBe('year.not_audited');

    expect((await call('POST', '/periods/2026/audit-request', cashier.access_token)).statusCode).toBe(200);
    expect((await call('POST', '/periods/2026/audit-request', cashier.access_token)).json().code).toBe('audit.already_requested');
    expect((await call('POST', '/periods/2026/audit-signoff', cashier.access_token)).statusCode).toBe(403);
    expect((await call('POST', '/periods/2026/audit-signoff', auditor.access_token)).statusCode).toBe(204);
    expect((await call('GET', '/periods/2026/audit', member.access_token)).json().status).toBe('approved');

    const made = await call('POST', '/periods/2026/archive', cashier.access_token);
    expect(made.statusCode).toBe(200);
    const dir = join(root, 'archives', '2026');
    const files = readdirSync(dir);
    for (const name of ['annual-summary.pdf', 'ledger.csv', 'payments.csv', 'dues.csv', 'fines.csv', 'votes.csv', 'proposals.csv', 'assets.csv', 'valuations.csv', 'members.csv', 'charity-statement.csv', 'README.txt', 'SHA256SUMS', 'statement-M01.pdf', 'statement-M08.pdf']) {
      expect(files, name).toContain(name);
    }
    expect(readFileSync(join(dir, 'annual-summary.pdf')).subarray(0, 4).toString()).toBe('%PDF');
    // every fingerprint matches its file: nothing was changed after it was written
    for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [sum, name] = [line.slice(0, 64), line.slice(66)];
      expect(createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'), name).toBe(sum);
    }
    expect((await call('POST', '/periods/2026/archive', cashier.access_token)).json().code).toBe('archive.exists');

    const zip = await call('GET', '/reports/annual?year=2026', member.access_token);
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await call('GET', '/reports/annual?year=2025', member.access_token)).statusCode).toBe(404);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='archive.create'`)).length).toBe(1);
  });
});

describe('statements and exports', () => {
  dbIt('a member gets their own statement as a PDF, not someone else\'s; the cashier gets any', async () => {
    const own = await call('GET', '/reports/statement?period=2026-12', member.access_token);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');
    expect(own.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await call('GET', `/reports/statement?period=2026-12&member_id=${fund.members.M03}`, member.access_token)).statusCode).toBe(403);
    expect((await call('GET', `/reports/statement?period=2026&member_id=${fund.members.M03}`, cashier.access_token)).statusCode).toBe(200);
    expect((await call('GET', '/reports/statement?period=nonsense', member.access_token)).statusCode).toBe(400);
    expect((await q(`SELECT 1 FROM audit_log WHERE action='report.statement'`)).length).toBeGreaterThanOrEqual(2);
  });

  dbIt('the zakat statement gives figures and is audited', async () => {
    const res = await call('GET', '/reports/zakat-statement', member.access_token);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await q(`SELECT 1 FROM audit_log WHERE action='report.zakat'`)).length).toBe(1);
  });

  dbIt('CSV exports carry the rows, no phone numbers or SMS text, and are audit-logged', async () => {
    const res = await call('GET', '/reports/export.csv?entity=ledger', member.access_token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.body.replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '');
    expect(text.split('\r\n')[0]).toBe('seq,entry_date,debit_account,credit_account,amount_paisa,member_code,ref_type,ref_id,memo,reverses_seq,hash');
    expect(text).toContain('opening');
    const pay = await call('GET', '/reports/export.csv?entity=payments', member.access_token);
    expect(pay.body).not.toMatch(/raw_sms|\+8801/);
    expect((await call('GET', '/reports/export.csv?entity=members', member.access_token)).statusCode).toBe(400);
    expect((await q(`SELECT after FROM audit_log WHERE action='report.export' ORDER BY id DESC LIMIT 1`))[0]).toBeTruthy();
  });

  dbIt('a spreadsheet formula in a memo is neutralised', async () => {
    await q(`INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, ref_type, memo)
             VALUES ('2027-01-02','CASH','MEMBER_CAPITAL',5,'import','=HYPERLINK("http://evil")')`);
    const res = await call('GET', '/reports/export.csv?entity=ledger&from=2027-01-01', member.access_token);
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('system status, alerts and the daily ledger check', () => {
  dbIt('shows the sidecar status files to the cashier and auditor only', async () => {
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(join(root, 'status', 'status.json'), JSON.stringify({ ok: true, finished: '2027-01-05T02:00:00Z', size: 1234, sha256: 'ab' }));
    const res = await call('GET', '/system/status', cashier.access_token);
    expect(res.statusCode).toBe(200);
    expect(res.json().backup).toMatchObject({ ok: true, size: 1234 });
    expect(res.json().restore_test).toBeNull();
    expect(res.json().disk.free_bytes).toBeGreaterThan(0);
    expect((await call('GET', '/system/status', member.access_token)).statusCode).toBe(403);

    expect((await call('POST', '/system/offline-copy', cashier.access_token)).statusCode).toBe(204);
    expect((await call('GET', '/system/status', auditor.access_token)).json().offline_copy).toMatchObject({ on: '2027-01-05' });
  });

  dbIt('the sidecar can raise a backup alert only with the shared secret', async () => {
    expect((await call('POST', '/internal/alert', undefined, { job: 'backup' })).statusCode).toBe(401);
    expect((await call('POST', '/internal/alert', undefined, { job: 'backup' }, { 'x-alert-secret': 'wrong-secret-wrong-secret' })).statusCode).toBe(401);
    const ok = await call('POST', '/internal/alert', undefined, { job: 'backup' }, { 'x-alert-secret': env.INTERNAL_ALERT_SECRET });
    expect(ok.statusCode).toBe(204);
    const rows = await q(`SELECT m.code, n.channel FROM notifications n JOIN members m ON m.id = n.member_id WHERE n.template='backup_failed' ORDER BY m.code, n.channel`);
    expect(rows).toEqual([
      { code: 'M01', channel: 'push' }, { code: 'M01', channel: 'sms' },
      { code: 'M07', channel: 'push' }, { code: 'M07', channel: 'sms' },
    ]);
  });

  dbIt('the ledger check records a good result and alerts on a tampered row', async () => {
    expect(await runLedgerVerify(db!.app, clock)).toEqual({ ok: true });
    expect(((await call('GET', '/system/status', cashier.access_token)).json().ledger_verify as { ok: boolean }).ok).toBe(true);

    await db!.admin.query(`ALTER TABLE ledger_entries DISABLE TRIGGER no_mutation_ledger`);
    try {
      await db!.admin.query(`UPDATE ledger_entries SET amount_paisa = amount_paisa + 1 WHERE seq = (SELECT min(seq) FROM ledger_entries)`);
      expect(await runLedgerVerify(db!.app, clock)).toEqual({ ok: false });
    } finally {
      await db!.admin.query(`UPDATE ledger_entries SET amount_paisa = amount_paisa - 1 WHERE seq = (SELECT min(seq) FROM ledger_entries)`);
      await db!.admin.query(`ALTER TABLE ledger_entries ENABLE TRIGGER no_mutation_ledger`);
    }
    expect(((await call('GET', '/system/status', cashier.access_token)).json().ledger_verify as { ok: boolean }).ok).toBe(false);
    const alerts = await q(`SELECT DISTINCT m.code FROM notifications n JOIN members m ON m.id = n.member_id WHERE n.template='ledger_verify_failed' ORDER BY 1`);
    expect(alerts.map((a) => a.code)).toEqual(['M01', 'M07']);
    expect(await runLedgerVerify(db!.app, clock)).toEqual({ ok: true });
  });
});
