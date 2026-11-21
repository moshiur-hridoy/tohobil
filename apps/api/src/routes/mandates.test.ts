import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import { computeNav } from '../lib/nav';
import { createTestDb, type TestDb } from '../test/db-harness';
import { AUDITOR_PIN, activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

// The real clock: TOTP codes made here are checked against the app's clock.
const clock = systemClock;

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M03' | 'M07', TestSession>;
let partnerId: string;
let mandateId: string;

const call = (method: 'GET' | 'POST', url: string, who?: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...(who && who === s.M07?.access_token ? AUDITOR_PIN : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

let fileN = 0;
async function receipt(userId: string): Promise<string> {
  const sha = `f${String(++fileN).padStart(63, '0')}`;
  const rows = await q(
    `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by) VALUES ($1, 'image/png', 10, $2, 'receipt.png', $3) RETURNING id`,
    [sha, `/data/files/${sha}.png`, userId],
  );
  return (rows[0] as { id: string }).id;
}

const balance = async (account: string): Promise<bigint> =>
  BigInt(((await q(`SELECT natural_balance_paisa::text AS b FROM v_account_balances WHERE code = $1`, [account]))[0] as { b: string }).b);

let trxN = 0;
const trx = () => `MANDATE${String(++trxN).padStart(5, '0')}`;
const today = () => clock.todayDhaka();
const period = () => today().slice(0, 7);
const COMPLIANCE = {
  interest_free_instrument: true,
  not_conventional_fixed_deposit: true,
  not_conventional_insurance: true,
  not_speculative_trading: true,
  permissible_business: true,
  liquidatable_within_term: true,
  no_fixed_profit_promised: true,
};

describe('standing investment approval (ASSUMPTIONS 131)', () => {
  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    app = await buildApp({ env: testEnv, db: db.app, clock });
    fund = await seedFund(db.admin);
    for (const code of ['M01', 'M02', 'M03', 'M07'] as const) Object.assign((s[code] = {} as TestSession), await activateSession(app, db, clock, fund, code));
    const enrol = await call('POST', '/auth/totp/enroll', s.M01.access_token);
    const secret = (enrol.json() as { secret: string }).secret;
    const verified = await call('POST', '/auth/totp/verify', s.M01.access_token, { code: authenticator.generate(secret) });
    if (verified.statusCode !== 200) throw new Error(verified.body);

    partnerId = (await call('POST', '/partners', s.M01.access_token, { kind: 'gold', name: 'Minar Jewellers' })).json().partner.id as string;
    // 2,00,000 taka in the bank to buy with.
    const paid = await call('POST', '/payments/cashier-entry', s.M01.access_token, {
      member_id: fund.members.M02,
      amount_paisa: '20000000',
      method: 'bank',
      trx_id: trx(),
      paid_at: `${today()}T00:30:00+06:00`,
    });
    if (paid.statusCode !== 201) throw new Error(paid.body);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  dbIt('a draft cannot go to a vote until every investment check is ticked', async () => {
    const created = await call('POST', '/proposals', s.M01.access_token, {
      type: 'investment_mandate',
      title: 'Minar every month',
      payload: { partner_id: partnerId, monthly_max_paisa: '5000000', first_period: period(), months: 12, compliance: { ...COMPLIANCE, permissible_business: false } },
    });
    expect(created.statusCode).toBe(200);
    const opened = await call('POST', `/proposals/${created.json().id as string}/open`, s.M01.access_token, {
      closes_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect(opened.json().code).toBe('proposal.compliance_incomplete');
  });

  dbIt('executing the passed vote records the approval; no money moves', async () => {
    const bankBefore = await balance('BANK');
    const pid = ((await q(
      `INSERT INTO proposals (type, title, payload, status, finalized_at, created_by)
       VALUES ('investment_mandate', 'Minar 50,000 a month', $1, 'approved', now(), $2) RETURNING id`,
      [JSON.stringify({ partner_id: partnerId, monthly_max_paisa: '5000000', first_period: period(), months: 12, compliance: COMPLIANCE }), fund.users.M01],
    ))[0] as { id: string }).id;
    const executed = await call('POST', `/proposals/${pid}/execute`, s.M01.access_token, {});
    expect(executed.statusCode).toBe(200);
    mandateId = executed.json().result_ref.mandate_id as string;
    expect(await balance('BANK')).toBe(bankBefore);

    const list = (await call('GET', `/mandates?partner_id=${partnerId}`, s.M03.access_token)).json().items as Array<Record<string, string>>;
    expect(list[0]).toMatchObject({ id: mandateId, status: 'active', first_period: period(), used_this_month_paisa: '0' });
    // the database lets the approval only be ended, never changed
    await expect(q(`UPDATE investment_mandates SET monthly_max_paisa = 1 WHERE id = $1`, [mandateId])).rejects.toThrow(/only be ended/);
  });

  dbIt('the cashier records a month\'s purchase with its receipt, without a vote', async () => {
    const bankBefore = await balance('BANK');
    const investedBefore = await balance('INVESTMENTS_AT_COST');
    const noReceipt = await call('POST', `/mandates/${mandateId}/purchases`, s.M01.access_token, { entry_date: today(), amount_paisa: '3000000' });
    expect(noReceipt.statusCode).toBe(400);
    const ok = await call('POST', `/mandates/${mandateId}/purchases`, s.M01.access_token, {
      entry_date: today(),
      amount_paisa: '3000000',
      receipt_file_id: await receipt(fund.users.M01),
      quantity: 1.5,
      unit: 'vori',
    });
    expect(ok.statusCode).toBe(201);
    expect(bankBefore - (await balance('BANK'))).toBe(3000000n);
    expect((await balance('INVESTMENTS_AT_COST')) - investedBefore).toBe(3000000n);
    const asset = (await q(`SELECT status, partner_id, mandate_id, cost_paisa::text AS cost FROM assets WHERE id = $1`, [ok.json().asset_id]))[0];
    expect(asset).toMatchObject({ status: 'held', partner_id: partnerId, mandate_id: mandateId, cost: '3000000' });
    // it shows on the shop's page like any purchase
    const page = (await call('GET', `/partners/${partnerId}`, s.M03.access_token)).json();
    expect(page.entries.some((e: { asset_id: string }) => e.asset_id === ok.json().asset_id)).toBe(true);
    expect(page.mandates[0].used_this_month_paisa).toBe('3000000');
    // members cannot record one
    expect((await call('POST', `/mandates/${mandateId}/purchases`, s.M02.access_token, { entry_date: today(), amount_paisa: '1', receipt_file_id: await receipt(fund.users.M02) })).statusCode).toBe(403);
  });

  dbIt('never goes past the monthly limit the members approved', async () => {
    const over = await call('POST', `/mandates/${mandateId}/purchases`, s.M01.access_token, {
      entry_date: today(),
      amount_paisa: '2000001',
      receipt_file_id: await receipt(fund.users.M01),
    });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ code: 'mandate.over_limit', left_paisa: '2000000' });
  });

  dbIt('dues sent straight to the shop pay the dues and become that month\'s purchase', async () => {
    const bankBefore = await balance('BANK');
    const investedBefore = await balance('INVESTMENTS_AT_COST');
    const capitalBefore = await balance('MEMBER_CAPITAL');
    // a levy can never go to a shop
    const levy = await call('POST', '/payments', s.M03.access_token, { amount_paisa: '500000', method: 'bkash', trx_id: trx(), purpose: 'levy', partner_id: partnerId });
    expect(levy.json().code).toBe('payment.shop_dues_only');

    const sent = await call('POST', '/payments', s.M03.access_token, { amount_paisa: '1000000', method: 'bkash', trx_id: trx(), partner_id: partnerId });
    expect(sent.statusCode).toBe(201);
    const pid = sent.json().id as string;
    const listed = (await call('GET', `/payments/${pid}`, s.M01.access_token)).json();
    expect(listed.partner_name ?? listed.payment?.partner_name).toBe('Minar Jewellers');
    const confirmed = await call('POST', `/payments/${pid}/confirm`, s.M01.access_token, {});
    expect(confirmed.statusCode).toBe(200);

    expect(await balance('BANK')).toBe(bankBefore); // in and straight out again
    expect((await balance('INVESTMENTS_AT_COST')) - investedBefore).toBe(1000000n);
    expect((await balance('MEMBER_CAPITAL')) - capitalBefore).toBe(1000000n);
    const used = (await call('GET', `/mandates?partner_id=${partnerId}`, s.M03.access_token)).json().items[0].used_this_month_paisa;
    expect(used).toBe('4000000');

    // Reversing the payment takes the purchase with it: NAV no longer counts it.
    const navBefore = (await computeNav(db!.app, today())).assets_paisa;
    const req = await call('POST', `/payments/${pid}/reverse-request`, s.M01.access_token, { reason: 'Sent to the wrong shop' });
    const approved = await call('POST', `/approvals/${req.json().approval_id as string}/approve`, s.M07.access_token, {});
    expect(approved.statusCode).toBe(200);
    expect(await balance('INVESTMENTS_AT_COST')).toBe(investedBefore);
    expect(await balance('MEMBER_CAPITAL')).toBe(capitalBefore);
    expect(navBefore - (await computeNav(db!.app, today())).assets_paisa).toBe(1000000n);
    expect((await call('GET', `/mandates?partner_id=${partnerId}`, s.M03.access_token)).json().items[0].used_this_month_paisa).toBe('3000000');
  });

  dbIt('a purchase recorded by mistake is reversed by the auditor, never edited', async () => {
    const purchases = (await call('GET', `/mandates/${mandateId}/purchases`, s.M03.access_token)).json().items as Array<{ asset_id: string; payment_id: string | null; reversed: boolean }>;
    const own = purchases.find((p) => !p.payment_id && !p.reversed)!;
    const investedBefore = await balance('INVESTMENTS_AT_COST');
    const req = await call('POST', `/mandate-purchases/${own.asset_id}/reverse-request`, s.M01.access_token, { reason: 'Typed the wrong amount' });
    expect(req.statusCode).toBe(201);
    // the cashier cannot approve their own request; the auditor can
    expect((await call('POST', `/approvals/${req.json().approval_id as string}/approve`, s.M01.access_token, {})).statusCode).toBe(403);
    const listed = (await call('GET', '/approvals?status=pending', s.M07.access_token)).json().items as Array<Record<string, string>>;
    expect(listed.find((a) => a.id === req.json().approval_id)).toMatchObject({ kind: 'mandate_purchase_reversal', partner_name: 'Minar Jewellers', purchase_amount_paisa: '3000000' });
    expect((await call('POST', `/approvals/${req.json().approval_id as string}/approve`, s.M07.access_token, {})).statusCode).toBe(200);
    expect(investedBefore - (await balance('INVESTMENTS_AT_COST'))).toBe(3000000n);
    const after = (await call('GET', `/mandates/${mandateId}/purchases`, s.M03.access_token)).json().items as Array<{ asset_id: string; reversed: boolean }>;
    expect(after.find((p) => p.asset_id === own.asset_id)?.reversed).toBe(true);
  });

  dbIt('ending the approval stops new purchases at once', async () => {
    expect((await call('POST', `/mandates/${mandateId}/end`, s.M02.access_token, { reason: 'Members asked to stop' })).statusCode).toBe(403);
    expect((await call('POST', `/mandates/${mandateId}/end`, s.M07.access_token, { reason: 'Members asked to stop' })).statusCode).toBe(204);
    const late = await call('POST', `/mandates/${mandateId}/purchases`, s.M01.access_token, {
      entry_date: today(),
      amount_paisa: '100000',
      receipt_file_id: await receipt(fund.users.M01),
    });
    expect(late.json().code).toBe('mandate.not_in_force');
    const direct = await call('POST', '/payments', s.M03.access_token, { amount_paisa: '100000', method: 'bkash', trx_id: trx(), partner_id: partnerId });
    expect(direct.json().code).toBe('mandate.not_in_force');
    expect((await call('GET', `/mandates?partner_id=${partnerId}`, s.M03.access_token)).json().items[0].status).toBe('ended');
  });
});
