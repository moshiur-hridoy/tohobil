import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { createFakeClock, systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import { generateDues } from '../dues/service';
import { createTestDb, type TestDb } from '../test/db-harness';
import {
  activateSession,
  seedFund,
  testEnv,
  type Fund,
  type TestSession,
} from '../test/fund-fixture';
import { multipartBody } from '../test/multipart';

// The real clock: TOTP codes made here are checked against the app's clock.
const clock = systemClock;
const dues = createFakeClock(new Date('2026-09-05T03:00:00Z'));

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M03' | 'M04' | 'M05' | 'M07', TestSession>;
let m: Fund['members'];

type Method = 'GET' | 'POST' | 'PATCH';
const call = (method: Method, url: string, who?: string, payload?: unknown, headers = {}) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

let trxCounter = 0;
const trx = () => `TRX${String(++trxCounter).padStart(7, '0')}`;

const secrets = new Map<string, string>();

async function stepUp(session: TestSession): Promise<void> {
  const res = await call('POST', '/auth/totp/verify', session.access_token, {
    code: authenticator.generate(secrets.get(session.device_id) as string),
  });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

async function enrolStepUp(session: TestSession): Promise<void> {
  const enrol = await call('POST', '/auth/totp/enroll', session.access_token);
  secrets.set(session.device_id, (enrol.json() as { secret: string }).secret);
  await stepUp(session);
}

const dueRows = async (memberId: string) =>
  (await q(
    `SELECT due_id, period, amount_paisa::text AS amount, outstanding_paisa::text AS outstanding, status
     FROM v_due_status WHERE member_id = $1 ORDER BY period`,
    [memberId],
  )) as Array<{ due_id: string; period: string; amount: string; outstanding: string; status: string }>;

const balance = async (account: string): Promise<bigint> => {
  const rows = await q(
    `SELECT COALESCE(SUM(CASE WHEN debit_account=$1 THEN amount_paisa ELSE 0 END),0)
          - COALESCE(SUM(CASE WHEN credit_account=$1 THEN amount_paisa ELSE 0 END),0) AS net
     FROM ledger_entries`,
    [account],
  );
  return BigInt((rows[0] as { net: string }).net);
};

const submit = (who: string, body: Record<string, unknown>, headers = {}) =>
  call(
    'POST',
    '/payments',
    who,
    { amount_paisa: '500000', method: 'bkash', trx_id: trx(), ...body },
    headers,
  );

const confirm = (id: string, body: unknown = {}, who = s.M01.access_token) =>
  call('POST', `/payments/${id}/confirm`, who, body);

const addFine = async (memberId: string, dueId: string, amount: number): Promise<string> =>
  ((await q(
    `INSERT INTO fines (due_id, member_id, amount_paisa) VALUES ($1,$2,$3) RETURNING id`,
    [dueId, memberId, amount],
  )) as Array<{ id: string }>)[0]!.id;

describe('payments', () => {
  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    m = fund.members;
    for (const code of ['M01', 'M02', 'M03', 'M04', 'M05', 'M07'] as const) {
      s[code] = await activateSession(app, db, clock, fund, code);
    }
    await enrolStepUp(s.M01);
    await enrolStepUp(s.M07);
    await generateDues({ pool: db.app, clock: dues }, { period: '2026-08' });
    await generateDues({ pool: db.app, clock: dues }, { period: '2026-09' });
  });

  afterAll(async () => {
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  // ---- submission ---------------------------------------------------------------------------

  dbIt('a pending payment touches no ledger, no allocation and no balance', async () => {
    const ledgerBefore = await q(`SELECT count(*)::int AS n FROM ledger_entries`);
    const res = await submit(s.M03.access_token, { amount_paisa: '500000' });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string; status: string };
    expect(res.json().status).toBe('pending');
    expect(await q(`SELECT count(*)::int AS n FROM ledger_entries`)).toEqual(ledgerBefore);
    expect(await q(`SELECT 1 FROM payment_allocations WHERE payment_id=$1`, [id])).toHaveLength(0);
    const m03 = await dueRows(m.M03);
    expect(m03.every((d) => d.outstanding === d.amount)).toBe(true);
    // the dues list says "under verification" while it is pending
    const list = await call('GET', `/dues?member_id=${m.M03}`, s.M02.access_token);
    expect((list.json().items as Array<{ under_verification: boolean }>).every((d) => d.under_verification)).toBe(true);
    await call('POST', `/payments/${id}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  dbIt('the payer is always the caller; a member_id in the body is ignored', async () => {
    const res = await submit(s.M03.access_token, { member_id: m.M02 });
    const { id } = res.json() as { id: string };
    expect(((await q(`SELECT member_id FROM payments WHERE id=$1`, [id]))[0] as { member_id: string }).member_id).toBe(m.M03);
    await call('POST', `/payments/${id}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  dbIt('validation: TrxID required for bkash/nagad/bank, not for cash; no future date; amount positive', async () => {
    const no = await call('POST', '/payments', s.M03.access_token, { amount_paisa: '100', method: 'bkash' });
    expect(no.statusCode).toBe(400);
    const zero = await submit(s.M03.access_token, { amount_paisa: '0' });
    expect(zero.statusCode).toBe(400);
    const future = await submit(s.M03.access_token, { paid_at: '2999-01-01T00:00:00+06:00' });
    expect(future.json().code).toBe('payment.paid_in_future');
    const cash = await call('POST', '/payments', s.M03.access_token, { amount_paisa: '100', method: 'cash' });
    expect(cash.statusCode).toBe(201);
    await call('POST', `/payments/${cash.json().id}/reject`, s.M01.access_token, { reason: 'test cleanup' });
    const levy = await submit(s.M03.access_token, { purpose: 'levy' });
    expect(levy.json().code).toBe('payment.purpose_unsupported');
  });

  dbIt('a suspended or read-only member cannot submit', async () => {
    await q(`UPDATE members SET status='suspended', suspended_on='2026-09-01' WHERE id=$1`, [m.M04]);
    const res = await submit(s.M04.access_token, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.read_only');
    await q(`UPDATE members SET status='active', suspended_on=NULL WHERE id=$1`, [m.M04]);
  });

  dbIt('a duplicate TrxID (case and spacing ignored) is 409 with a pointer; a rejected one can be resubmitted', async () => {
    const first = await submit(s.M03.access_token, { trx_id: 'AbC123Dup9' });
    const id = first.json().id as string;
    const dup = await submit(s.M02.access_token, { trx_id: '  abc123dup9 ' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('payment.duplicate_trx');
    expect(dup.json().existing_payment_id).toBe(id);

    expect((await call('POST', `/payments/${id}/reject`, s.M01.access_token, { reason: 'wrong amount' })).statusCode).toBe(200);
    const again = await submit(s.M03.access_token, { trx_id: 'ABC123DUP9' });
    expect(again.statusCode).toBe(201);
    // a confirmed one blocks too
    await confirm(again.json().id);
    const third = await submit(s.M02.access_token, { trx_id: 'abc123dup9' });
    expect(third.statusCode).toBe(409);
  });

  dbIt('an Idempotency-Key replays the first answer instead of creating a second payment', async () => {
    const key = 'pay-idem-key-0001';
    const body = { trx_id: trx() };
    const a = await submit(s.M02.access_token, body, { 'idempotency-key': key });
    const b = await submit(s.M02.access_token, body, { 'idempotency-key': key });
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const rows = await q(`SELECT 1 FROM payments WHERE trx_id=$1`, [body.trx_id]);
    expect(rows).toHaveLength(1);
    await call('POST', `/payments/${a.json().id}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  dbIt('a proof must be the payer\'s own uploaded file', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
    const upload = multipartBody([{ name: 'file', filename: 'p.png', contentType: 'image/png', data: png }]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: upload.payload,
      headers: { authorization: `Bearer ${s.M03.access_token}`, 'content-type': upload.contentType },
    });
    const fileId = up.json().id as string;
    const other = await submit(s.M02.access_token, { proof_file_id: fileId });
    expect(other.statusCode).toBe(404);
    const own = await submit(s.M03.access_token, { proof_file_id: fileId });
    expect(own.statusCode).toBe(201);
    await call('POST', `/payments/${own.json().id}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  // ---- confirm and allocation ---------------------------------------------------------------

  dbIt('confirm needs the cashier and a recent step-up', async () => {
    const p = (await submit(s.M03.access_token, {})).json().id as string;
    expect((await confirm(p, {}, s.M02.access_token)).statusCode).toBe(403);
    expect((await confirm(p, {}, s.M07.access_token)).statusCode).toBe(403);
    // the cashier's 12 h step-up window lapses
    await q(`UPDATE devices SET step_up_at = NULL WHERE id = $1`, [s.M01.device_id]);
    const res = await confirm(p);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.step_up_required');
    await stepUp(s.M01);
    await call('POST', `/payments/${p}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  dbIt('confirm pays the oldest due first and posts DR method / CR MEMBER_CAPITAL', async () => {
    // M04 (1 share) has two monthly dues and no payment yet at this point
    const before = await dueRows(m.M05);
    const [aug, sep] = before;
    const half = BigInt(aug!.amount) / 2n;
    const cashBefore = await balance('BKASH');
    const capitalBefore = await balance('MEMBER_CAPITAL');

    const p = (await submit(s.M05.access_token, { amount_paisa: half.toString() })).json().id as string;
    const res = await confirm(p);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('confirmed');
    expect(res.json().allocation.principal_paisa).toBe(half.toString());

    const after = await dueRows(m.M05);
    expect(BigInt(after[0]!.outstanding)).toBe(BigInt(aug!.amount) - half);
    expect(after[1]!.outstanding).toBe(sep!.outstanding);

    expect((await balance('BKASH')) - cashBefore).toBe(half);
    expect(capitalBefore - (await balance('MEMBER_CAPITAL'))).toBe(half);
    const entry = (await q(`SELECT * FROM ledger_entries WHERE ref_type='payment' AND ref_id=$1`, [p])) as Array<Record<string, string>>;
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ debit_account: 'BKASH', credit_account: 'MEMBER_CAPITAL', member_id: m.M05 });
    const pay = (await q(`SELECT status, confirmed_by, confirmed_at, unallocated_paisa FROM payments WHERE id=$1`, [p]))[0] as Record<string, unknown>;
    expect(pay['status']).toBe('confirmed');
    expect(pay['confirmed_by']).toBe(fund.users.M01);
    expect(String(pay['unallocated_paisa'])).toBe('0');
  });

  dbIt('a fine is paid after principal and posts to CHARITY_PAYABLE; the rest is credit', async () => {
    const [aug, sep] = await dueRows(m.M02); // 4 shares
    const fine = await addFine(m.M02, aug!.due_id, 200_000);
    const need = BigInt(aug!.outstanding) + BigInt(sep!.outstanding);
    const amount = need + 200_000n + 70_000n; // everything + fine + 70,000 credit
    const charityBefore = await balance('CHARITY_PAYABLE');

    const p = (await submit(s.M02.access_token, { amount_paisa: amount.toString(), method: 'nagad' })).json().id as string;
    const res = await confirm(p);
    expect(res.statusCode).toBe(200);
    expect(res.json().allocation).toMatchObject({
      principal_paisa: need.toString(),
      fine_paisa: '200000',
      credit_paisa: '70000',
    });

    const entries = (await q(
      `SELECT debit_account, credit_account, amount_paisa::text AS amount, memo FROM ledger_entries WHERE ref_id=$1 ORDER BY seq`,
      [p],
    )) as Array<Record<string, string>>;
    expect(entries.map((e) => [e['debit_account'], e['credit_account'], e['amount'], e['memo']])).toEqual([
      ['NAGAD', 'MEMBER_CAPITAL', need.toString(), 'principal'],
      ['NAGAD', 'MEMBER_CAPITAL', '70000', 'credit'],
      ['NAGAD', 'CHARITY_PAYABLE', '200000', 'fine'],
    ]);
    expect(charityBefore - (await balance('CHARITY_PAYABLE'))).toBe(200_000n);
    expect(((await q(`SELECT unallocated_paisa::text AS u FROM payments WHERE id=$1`, [p]))[0] as { u: string }).u).toBe('70000');
    const fines = await call('GET', `/fines?member_id=${m.M02}`, s.M02.access_token);
    expect(fines.json().items[0]).toMatchObject({ id: fine, status: 'paid', outstanding_paisa: '0' });
    expect((await dueRows(m.M02)).every((d) => d.outstanding === '0')).toBe(true);
  });

  dbIt('confirm twice is 409 and posts nothing more', async () => {
    const p = (await submit(s.M03.access_token, { amount_paisa: '1000' })).json().id as string;
    expect((await confirm(p)).statusCode).toBe(200);
    const n = (await q(`SELECT count(*)::int AS n FROM ledger_entries`))[0] as { n: number };
    const again = await confirm(p);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('payment.not_pending');
    expect(((await q(`SELECT count(*)::int AS n FROM ledger_entries`))[0] as { n: number }).n).toBe(n.n);
  });

  dbIt('two simultaneous confirms of one payment: exactly one wins', async () => {
    const p = (await submit(s.M03.access_token, { amount_paisa: '2000' })).json().id as string;
    const [a, b] = await Promise.all([confirm(p), confirm(p)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await q(`SELECT 1 FROM ledger_entries WHERE ref_id=$1`, [p])).toHaveLength(1);
  });

  dbIt('manual allocation: validated, remainder becomes credit', async () => {
    const [, sep] = await dueRows(m.M03);
    const p = (await submit(s.M03.access_token, { amount_paisa: '300000' })).json().id as string;

    const tooMuch = await confirm(p, { allocations: [{ due_id: sep!.due_id, amount_paisa: '999999999' }] });
    expect(tooMuch.json().code).toMatch(/payment\.allocation_exceeds/);
    const foreign = await confirm(p, { allocations: [{ due_id: (await dueRows(m.M02))[0]!.due_id, amount_paisa: '1' }] });
    expect(foreign.json().code).toBe('payment.allocation_invalid');
    expect(await q(`SELECT 1 FROM ledger_entries WHERE ref_id=$1`, [p])).toHaveLength(0); // rolled back

    const ok = await confirm(p, { allocations: [{ due_id: sep!.due_id, amount_paisa: '100000' }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().allocation).toMatchObject({ principal_paisa: '100000', credit_paisa: '200000' });
  });

  dbIt('confirmation preview and detail: cashier sees the effect, the SMS view is audited', async () => {
    const p = (await call('POST', '/payments', s.M03.access_token, { amount_paisa: '1000', method: 'cash' })).json().id as string;
    const detail = await call('GET', `/payments/${p}`, s.M01.access_token);
    expect(detail.json().preview).toMatchObject({ credit_paisa: expect.any(String) });
    expect((await call('GET', `/payments/${p}`, s.M03.access_token)).json().preview).toBeNull();
    await call('POST', `/payments/${p}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  // ---- cashier entry ------------------------------------------------------------------------

  dbIt('cashier entry creates and confirms in one step, notifies the member, honours TrxID uniqueness', async () => {
    const body = {
      member_id: m.M04,
      amount_paisa: '500000',
      method: 'cash',
      paid_at: '2026-09-02T10:00:00+06:00',
    };
    const res = await call('POST', '/payments/cashier-entry', s.M01.access_token, body);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const row = (await q(`SELECT status, source FROM payments WHERE id=$1`, [id]))[0] as Record<string, string>;
    expect(row).toMatchObject({ status: 'confirmed', source: 'cashier_entry' });
    const note = (await q(`SELECT template, payload FROM notifications WHERE member_id=$1 AND template='payment_confirmed'`, [m.M04])) as Array<{ template: string; payload: Record<string, string> }>;
    expect(note).toHaveLength(1);
    expect(note[0]!.payload['objection_link']).toContain(id);
    expect(await balance('CASH')).toBeGreaterThan(0n);

    // not for ordinary members or the auditor
    expect((await call('POST', '/payments/cashier-entry', s.M02.access_token, body)).statusCode).toBe(403);
    expect((await call('POST', '/payments/cashier-entry', s.M07.access_token, body)).statusCode).toBe(403);

    const withSms = { ...body, method: 'bkash', trx_id: 'SMSTRX0001', raw_sms: 'You have received Tk 5,000.00 from 01700000004. TrxID SMSTRX0001 at 02/09/2026 10:00' };
    const sms = await call('POST', '/payments/cashier-entry', s.M01.access_token, withSms);
    expect(sms.statusCode).toBe(201);
    expect(((await q(`SELECT source FROM payments WHERE id=$1`, [sms.json().id]))[0] as { source: string }).source).toBe('sms_match');
    const dup = await call('POST', '/payments/cashier-entry', s.M01.access_token, withSms);
    expect(dup.json().code).toBe('payment.duplicate_trx');
    // and the duplicate left nothing half-created
    expect(await q(`SELECT 1 FROM payments WHERE trx_id='SMSTRX0001'`)).toHaveLength(1);

    // a payment dated in a locked month is booked today instead
    await q(`INSERT INTO periods (period, locked_at) VALUES ('2026-06', now()) ON CONFLICT (period) DO UPDATE SET locked_at = now()`);
    const locked = await call('POST', '/payments/cashier-entry', s.M01.access_token, { ...body, paid_at: '2026-06-10T10:00:00+06:00' });
    expect(locked.statusCode).toBe(201);
    const dated = (await q(`SELECT entry_date::text AS d FROM ledger_entries WHERE ref_id=$1`, [locked.json().id]))[0] as { d: string };
    expect(dated.d >= '2026-09-01').toBe(true);
    await q(`UPDATE periods SET locked_at = NULL WHERE period = '2026-06'`);
  });

  // ---- reject -------------------------------------------------------------------------------

  dbIt('reject needs a reason, marks the payment, notifies, and cannot be confirmed afterwards', async () => {
    const p = (await submit(s.M04.access_token, {})).json().id as string;
    expect((await call('POST', `/payments/${p}/reject`, s.M01.access_token, { reason: 'ab' })).statusCode).toBe(400);
    expect((await call('POST', `/payments/${p}/reject`, s.M01.access_token, { reason: 'amount does not match SMS' })).statusCode).toBe(200);
    expect(((await q(`SELECT status, reject_reason FROM payments WHERE id=$1`, [p]))[0] as Record<string, string>)).toMatchObject({ status: 'rejected', reject_reason: 'amount does not match SMS' });
    expect((await confirm(p)).json().code).toBe('payment.not_pending');
    expect(await q(`SELECT 1 FROM notifications WHERE member_id=$1 AND template='payment_rejected'`, [m.M04])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM ledger_entries WHERE ref_id=$1`, [p])).toHaveLength(0);
  });

  // ---- visibility ---------------------------------------------------------------------------

  dbIt('everyone sees amounts and status; TrxID, note, proof and SMS only the payer, cashier and auditor', async () => {
    const p = (await submit(s.M03.access_token, { amount_paisa: '1234', note: 'private note', trx_id: 'SEECRET001' })).json().id as string;
    const find = (res: { json(): { items: Array<Record<string, unknown>> } }) => res.json().items.find((i) => i['id'] === p)!;
    const other = find(await call('GET', '/payments?status=pending', s.M02.access_token));
    expect(other).toMatchObject({ amount_paisa: '1234', method: 'bkash', status: 'pending', member_code: 'M03', trx_id: null, note: null, proof_file_id: null });
    for (const who of [s.M03, s.M01, s.M07]) {
      const row = find(await call('GET', '/payments?status=pending', who.access_token));
      expect(row).toMatchObject({ trx_id: 'SEECRET001', note: 'private note' });
    }
    await call('POST', `/payments/${p}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  dbIt('raw SMS is returned to the payer and staff only, and viewing it is audited', async () => {
    const entry = await call('POST', '/payments/cashier-entry', s.M01.access_token, {
      member_id: m.M03,
      amount_paisa: '1000',
      method: 'bkash',
      trx_id: 'RAWSMS0001',
      paid_at: '2026-09-02T10:00:00+06:00',
      raw_sms: 'the raw text',
    });
    const id = entry.json().id as string;
    expect((await call('GET', `/payments/${id}`, s.M02.access_token)).json().raw_sms).toBeNull();
    const before = (await q(`SELECT count(*)::int AS n FROM audit_log WHERE action='payment.view_raw_sms'`))[0] as { n: number };
    expect((await call('GET', `/payments/${id}`, s.M03.access_token)).json().raw_sms).toBe('the raw text');
    expect((await call('GET', `/payments/${id}`, s.M07.access_token)).json().raw_sms).toBe('the raw text');
    const after = (await q(`SELECT count(*)::int AS n FROM audit_log WHERE action='payment.view_raw_sms'`))[0] as { n: number };
    expect(after.n).toBe(before.n + 2);
    const list = await call('GET', '/payments', s.M02.access_token);
    expect(JSON.stringify(list.json())).not.toContain('the raw text');
  });

  dbIt('the list pages with a cursor and filters by status and member', async () => {
    const all = await call('GET', '/payments?limit=3', s.M02.access_token);
    expect(all.json().items).toHaveLength(3);
    expect(all.json().next_cursor).toBeTruthy();
    const next = await call('GET', `/payments?limit=3&cursor=${all.json().next_cursor}`, s.M02.access_token);
    const ids = new Set([...all.json().items, ...next.json().items].map((i: { id: string }) => i.id));
    expect(ids.size).toBe(next.json().items.length + 3);
    const byMember = await call('GET', `/payments?member_id=${m.M04}&status=confirmed`, s.M02.access_token);
    expect(byMember.json().items.every((i: { member_code: string; status: string }) => i.member_code === 'M04' && i.status === 'confirmed')).toBe(true);
    expect((await call('GET', '/payments')).statusCode).toBe(401);
  });

  // ---- reversal -----------------------------------------------------------------------------

  dbIt('reversal: cashier requests, a different person (the auditor) approves; outstanding is restored and the books balance', async () => {
    const before = await dueRows(m.M03);
    const target = before.find((d) => BigInt(d.outstanding) > 0n)!;
    const p = (await submit(s.M03.access_token, { amount_paisa: '100000' })).json().id as string;
    await confirm(p, { allocations: [{ due_id: target.due_id, amount_paisa: '60000' }] }); // 60k principal + 40k credit
    const afterConfirm = await dueRows(m.M03);
    const outstandingMid = BigInt(afterConfirm.find((d) => d.due_id === target.due_id)!.outstanding);
    expect(outstandingMid).toBe(BigInt(target.outstanding) - 60_000n);
    const capital = await balance('MEMBER_CAPITAL');

    const req = await call('POST', `/payments/${p}/reverse-request`, s.M01.access_token, { reason: 'paid to the wrong member' });
    expect(req.statusCode).toBe(201);
    const approvalId = req.json().approval_id as string;
    // nothing moved yet
    expect(await balance('MEMBER_CAPITAL')).toBe(capital);
    expect((await call('POST', `/payments/${p}/reverse-request`, s.M01.access_token, { reason: 'again please' })).json().code).toBe('approval.already_pending');
    // ordinary members and the cashier cannot decide
    expect((await call('POST', `/approvals/${approvalId}/approve`, s.M02.access_token, {})).statusCode).toBe(403);
    expect((await call('POST', `/approvals/${approvalId}/approve`, s.M01.access_token, {})).statusCode).toBe(403);
    const pending = await call('GET', '/approvals?status=pending', s.M07.access_token);
    expect(pending.json().items.find((a: { id: string }) => a.id === approvalId)).toMatchObject({ kind: 'payment_reversal', requested_by_code: 'M01', payment_member_code: 'M03', payment_amount_paisa: '100000' });

    const ok = await call('POST', `/approvals/${approvalId}/approve`, s.M07.access_token, { note: 'checked the SMS' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reversal_seqs).toHaveLength(2);

    expect(await balance('MEMBER_CAPITAL')).toBe(capital + 100_000n);
    const restored = await dueRows(m.M03);
    expect(restored.find((d) => d.due_id === target.due_id)!.outstanding).toBe(target.outstanding);
    const pay = (await q(`SELECT status, unallocated_paisa::text AS u FROM payments WHERE id=$1`, [p]))[0] as Record<string, string>;
    expect(pay).toMatchObject({ status: 'reversed', u: '0' });
    const rev = (await q(`SELECT ref_type, reverses_seq FROM ledger_entries WHERE ref_id=$1 ORDER BY seq`, [p])) as Array<{ ref_type: string; reverses_seq: string | null }>;
    expect(rev.map((r) => r.ref_type)).toEqual(['payment', 'payment', 'payment_reversal', 'payment_reversal']);
    // the allocation rows were never edited: negative rows were added
    expect(((await q(`SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id=$1 AND amount_paisa < 0`, [p]))[0] as { n: number }).n).toBe(1);

    // decided once; the reversed payment cannot be reversed again; its TrxID is free again
    expect((await call('POST', `/approvals/${approvalId}/approve`, s.M07.access_token, {})).json().code).toBe('approval.already_decided');
    expect((await call('POST', `/payments/${p}/reverse-request`, s.M01.access_token, { reason: 'again please' })).json().code).toBe('payment.not_confirmed');
    expect((await call('GET', '/ledger/verify', s.M02.access_token)).json().ok).toBe(true);
  });

  dbIt('a rejected reversal leaves the payment confirmed; the cashier cannot approve their own request (database rule too)', async () => {
    const p = (await submit(s.M03.access_token, { amount_paisa: '5000' })).json().id as string;
    await confirm(p);
    const approvalId = (await call('POST', `/payments/${p}/reverse-request`, s.M01.access_token, { reason: 'changed my mind' })).json().approval_id as string;
    const no = await call('POST', `/approvals/${approvalId}/reject`, s.M07.access_token, { note: 'no good reason' });
    expect(no.statusCode).toBe(200);
    expect(((await q(`SELECT status FROM payments WHERE id=$1`, [p]))[0] as { status: string }).status).toBe('confirmed');
    await expect(
      db!.admin.query(`UPDATE approvals SET status='approved', decided_by=requested_by, decided_at=now() WHERE id=$1`, [approvalId]),
    ).rejects.toThrow();
  });

  dbIt('reversing a payment that had paid a fine reopens the fine and unwinds charity money', async () => {
    const [aug] = await dueRows(m.M04);
    const fine = await addFine(m.M04, aug!.due_id, 50_000);
    const owed = (await q(`SELECT COALESCE(SUM(outstanding_paisa),0)::text AS n FROM v_due_status WHERE member_id=$1`, [m.M04]))[0] as { n: string };
    const amount = BigInt(owed.n) + 50_000n;
    const p = (await submit(s.M04.access_token, { amount_paisa: amount.toString() })).json().id as string;
    await confirm(p);
    const charity = await balance('CHARITY_PAYABLE');
    const approvalId = (await call('POST', `/payments/${p}/reverse-request`, s.M01.access_token, { reason: 'duplicate deposit' })).json().approval_id as string;
    await call('POST', `/approvals/${approvalId}/approve`, s.M07.access_token, {});
    expect(await balance('CHARITY_PAYABLE')).toBe(charity + 50_000n);
    const fines = await call('GET', `/fines?member_id=${m.M04}`, s.M02.access_token);
    expect(fines.json().items.find((f: { id: string }) => f.id === fine)).toMatchObject({ outstanding_paisa: '50000' });
  });

  dbIt('a reversal in a locked period is dated today', async () => {
    const p = (await call('POST', '/payments/cashier-entry', s.M01.access_token, {
      member_id: m.M03, amount_paisa: '7000', method: 'cash', paid_at: '2026-07-10T10:00:00+06:00',
    })).json().id as string;
    await q(`INSERT INTO periods (period, locked_at) VALUES ('2026-07', now()) ON CONFLICT (period) DO UPDATE SET locked_at = now()`);
    const approvalId = (await call('POST', `/payments/${p}/reverse-request`, s.M01.access_token, { reason: 'entered twice' })).json().approval_id as string;
    expect((await call('POST', `/approvals/${approvalId}/approve`, s.M07.access_token, {})).statusCode).toBe(200);
    const dates = (await q(`SELECT ref_type, entry_date::text AS d FROM ledger_entries WHERE ref_id=$1 ORDER BY seq`, [p])) as Array<{ ref_type: string; d: string }>;
    expect(dates[0]!.d).toBe('2026-07-10');
    expect(dates[1]!.ref_type).toBe('payment_reversal');
    expect(dates[1]!.d >= '2026-09-01').toBe(true);
    await q(`UPDATE periods SET locked_at = NULL WHERE period = '2026-07'`);
  });

  // ---- SMS parser route ---------------------------------------------------------------------

  dbIt('parse-sms is cashier only, parses, and suggests the pending payment by TrxID or amount and date', async () => {
    const pending = (await submit(s.M03.access_token, { amount_paisa: '1750000', trx_id: 'AB12CD34EF', paid_at: '2026-09-04T21:00:00+06:00' })).json().id as string;
    const other = (await submit(s.M02.access_token, { amount_paisa: '1750000', method: 'cash', paid_at: '2026-09-03T12:00:00+06:00', trx_id: undefined })).json().id as string;
    const text = 'You have received Tk 17,500.00 from 01700000003. Fee Tk 0.00. Balance Tk 38,486.45. TrxID ab12cd34ef at 04/09/2026 22:00';

    expect((await call('POST', '/payments/parse-sms', s.M02.access_token, { text })).statusCode).toBe(403);
    const res = await call('POST', '/payments/parse-sms', s.M01.access_token, { text });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ parsed: true, method: 'bkash', amount_paisa: '1750000', trx_id: 'AB12CD34EF', balance_paisa: '3848645' });
    const matches = res.json().matches as Array<{ payment_id: string; match_type: string; exact: boolean }>;
    expect(matches[0]).toMatchObject({ payment_id: pending, match_type: 'trx_id', exact: true });
    expect(matches.find((x) => x.payment_id === other)).toMatchObject({ match_type: 'amount_phone', exact: false });

    const junk = await call('POST', '/payments/parse-sms', s.M01.access_token, { text: 'hello world' });
    expect(junk.statusCode).toBe(200);
    expect(junk.json()).toMatchObject({ parsed: false, amount_paisa: null, matches: [] });
    for (const id of [pending, other]) await call('POST', `/payments/${id}/reject`, s.M01.access_token, { reason: 'test cleanup' });
  });

  // ---- invariants ---------------------------------------------------------------------------

  dbIt('every payment write left an audit row, with no secret in it', async () => {
    const rows = (await q(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'payment.%' OR action LIKE 'approval.%'`)) as Array<{ action: string }>;
    const seen = rows.map((r) => r.action);
    for (const action of [
      'payment.submit', 'payment.confirm', 'payment.cashier_entry', 'payment.reject',
      'payment.reverse_request', 'payment.reverse', 'approval.reject', 'payment.view_raw_sms',
    ]) {
      expect(seen).toContain(action);
    }
    const all = JSON.stringify(await q(`SELECT before, after FROM audit_log WHERE action LIKE 'payment.%'`));
    expect(all).not.toContain('the raw text'); // the SMS body is never copied into the audit log
  });

  dbIt('after all of this the ledger chain verifies and every confirmed payment is fully accounted for', async () => {
    expect((await call('GET', '/ledger/verify', s.M02.access_token)).json()).toMatchObject({ ok: true });
    const bad = await q(
      `SELECT p.id FROM payments p
       LEFT JOIN (SELECT payment_id, SUM(amount_paisa) AS a FROM payment_allocations GROUP BY payment_id) al ON al.payment_id = p.id
       WHERE p.status = 'confirmed' AND COALESCE(al.a,0) + p.unallocated_paisa <> p.amount_paisa`,
    );
    expect(bad).toEqual([]);
    // every confirmed payment's ledger entries add up to its amount
    const mismatch = await q(
      `SELECT p.id FROM payments p
       WHERE p.status = 'confirmed'
         AND (SELECT COALESCE(SUM(amount_paisa),0) FROM ledger_entries e WHERE e.ref_type='payment' AND e.ref_id=p.id) <> p.amount_paisa`,
    );
    expect(mismatch).toEqual([]);
  });
});
