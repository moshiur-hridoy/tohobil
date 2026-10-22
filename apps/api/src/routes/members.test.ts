import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ACCOUNT_CODES, createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { generateDues } from '../dues/service';
import { createTestDb, type TestDb } from '../test/db-harness';
import {
  FIXTURE_CODES,
  FIXTURE_SHARES,
  activateAndLogin,
  addConfirmedPayment,
  seedFund,
  testEnv,
  type Fund,
} from '../test/fund-fixture';

// 5 Nov 2026, 09:00 in Dhaka. The dues views judge "overdue" by the database's own clock, so these
// tests never assert `overdue` or `unpaid` for an unpaid due; they assert what does not depend on today.
const clock = createFakeClock(new Date('2026-11-05T03:00:00Z'));

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const token = {} as Record<'M01' | 'M02' | 'M03' | 'M04' | 'M07', string>;
let m: Fund['members'];

const call = (
  method: 'GET' | 'PATCH' | 'PUT',
  url: string,
  who?: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    ...(who ? { headers: { authorization: `Bearer ${who}` } } : {}),
    ...(payload ? { payload } : {}),
  });

const get = (url: string, who?: string) => call('GET', url, who);

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

async function dueId(memberId: string, period: string): Promise<string> {
  const rows = await q(`SELECT id FROM dues WHERE member_id=$1 AND period=$2 AND kind='monthly'`, [
    memberId,
    period,
  ]);
  return (rows[0] as { id: string }).id;
}

async function allocate(
  paymentId: string,
  target: { due?: string; fine?: string },
  amount: number,
) {
  await q(
    `INSERT INTO payment_allocations (payment_id, due_id, fine_id, amount_paisa) VALUES ($1,$2,$3,$4)`,
    [paymentId, target.due ?? null, target.fine ?? null, amount],
  );
  await q(`UPDATE payments SET unallocated_paisa = unallocated_paisa - $2 WHERE id = $1`, [
    paymentId,
    amount,
  ]);
}

async function addFine(memberId: string, amount: number): Promise<string> {
  const rows = await q(
    `INSERT INTO fines (due_id, member_id, amount_paisa) VALUES ($1,$2,$3) RETURNING id`,
    [await dueId(memberId, '2026-10'), memberId, amount],
  );
  return (rows[0] as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  m = fund.members;
  for (const code of ['M01', 'M02', 'M03', 'M04', 'M07'] as const) {
    token[code] = await activateAndLogin(app, db, clock, fund, code);
  }

  await generateDues({ pool: db.app, clock }, { period: '2026-10' });
  await generateDues({ pool: db.app, clock }, { period: '2026-11' });

  // M03 paid October in full, on time, and the cashier posted it to the ledger.
  const p1 = await addConfirmedPayment(db.admin, m.M03, 500_000, {
    confirmedAt: '2026-10-10T06:00:00Z',
    trxId: 'TRX-ONE',
    method: 'bkash',
    note: 'paid by bKash',
    rawSms: 'secret sms text',
  });
  await allocate(p1, { due: await dueId(m.M03, '2026-10') }, 500_000);
  await q(
    `INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, member_id, ref_type, ref_id)
     VALUES ('2026-10-10', 'BKASH', 'MEMBER_CAPITAL', 500000, $1, 'payment', $2)`,
    [m.M03, p1],
  );

  // M04 has submitted a payment that waits for the cashier.
  await q(
    `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, trx_id, raw_sms)
     VALUES ($1, 500000, 'nagad', '2026-11-04T06:00:00Z', 'pending', 'member_submitted', 'TRX-PENDING', 'secret sms text')`,
    [m.M04],
  );

  // Fines on October: unpaid (M05), partly paid (M06), waived (M02), fully paid (M08).
  await addFine(m.M05, 150_000);
  const partlyPaid = await addFine(m.M06, 50_000);
  const waived = await addFine(m.M02, 200_000);
  const paid = await addFine(m.M08, 200_000);
  await allocate(
    await addConfirmedPayment(db.admin, m.M06, 20_000, { unallocated: 20_000 }),
    { fine: partlyPaid },
    20_000,
  );
  await allocate(
    await addConfirmedPayment(db.admin, m.M08, 200_000, { unallocated: 200_000 }),
    { fine: paid },
    200_000,
  );
  await q(
    `UPDATE fines SET waived_by_proposal = gen_random_uuid(), waived_at = now() WHERE id = $1`,
    [waived],
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

describe('every new route needs a logged-in user', () => {
  const routes: Array<['GET' | 'PATCH', string]> = [
    ['GET', '/members'],
    ['GET', '/members/00000000-0000-0000-0000-000000000001'],
    ['GET', '/share-register'],
    ['GET', '/share-holdings'],
    ['GET', '/rules'],
    ['GET', '/accounts/balances'],
    ['GET', '/dues'],
    ['GET', '/fines'],
    ['PATCH', '/members/me'],
    ['PATCH', '/members/00000000-0000-0000-0000-000000000001/contact'],
  ];
  for (const [method, url] of routes) {
    dbIt(`${method} ${url} without a token is 401`, async () => {
      const res = await call(
        method,
        url,
        undefined,
        method === 'PATCH' ? { full_name: 'x' } : undefined,
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('auth.unauthorized');
    });
  }
});

describe('GET /members', () => {
  dbIt('lists every member in code order with shares and money as digit strings', async () => {
    const res = await get('/members', token.M02);
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    expect(items.map((i) => i['code'])).toEqual([...FIXTURE_CODES]);
    expect(items.map((i) => i['shares'])).toEqual([...FIXTURE_SHARES]);
    expect(items.map((i) => i['status'])).toEqual(Array(8).fill('active'));
    for (const i of items) {
      expect(i['capital_paisa']).toMatch(/^-?\d+$/);
      expect(i['outstanding_principal_paisa']).toMatch(/^\d+$/);
      expect(i['outstanding_fines_paisa']).toMatch(/^\d+$/);
      expect(i['overdue_paisa']).toMatch(/^\d+$/);
      expect(BigInt(i['overdue_paisa'] as string)).toBeLessThanOrEqual(BigInt(i['outstanding_principal_paisa'] as string));
      expect(i['current_period']).toBe('2026-11');
    }
  });

  dbIt("hides other members' phone numbers from a regular member but shows their own", async () => {
    const { items } = (await get('/members', token.M03)).json() as {
      items: Array<{ code: string; phone: string | null }>;
    };
    expect(items.find((i) => i.code === 'M03')?.phone).toBe('+8801700000003');
    expect(items.filter((i) => i.code !== 'M03').every((i) => i.phone === null)).toBe(true);
  });

  dbIt('shows every phone number to the cashier and to the auditor', async () => {
    for (const who of [token.M01, token.M07]) {
      const { items } = (await get('/members', who)).json() as {
        items: Array<{ phone: string | null }>;
      };
      expect(items.every((i) => /^\+8801\d{9}$/.test(i.phone ?? ''))).toBe(true);
    }
  });

  dbIt(
    "summarises each member's standing: capital, outstanding, this month, under verification",
    async () => {
      const { items } = (await get('/members', token.M02)).json() as {
        items: Array<Record<string, unknown> & { code: string }>;
      };
      const by = (code: string) => items.find((i) => i.code === code)!;

      // M03 paid October in full and has only November (500000) left.
      expect(by('M03')).toMatchObject({
        capital_paisa: '500000',
        outstanding_principal_paisa: '500000',
      });
      // M01 owes October and November, 2 shares each.
      expect(by('M01')).toMatchObject({
        capital_paisa: '0',
        outstanding_principal_paisa: '2000000',
      });
      expect(['unpaid', 'overdue']).toContain(by('M01')['current_period_status']);

      // M05's October fine is unpaid, M06's is part paid (50000 - 20000), M02's is waived, M08's is paid.
      expect(by('M05')['outstanding_fines_paisa']).toBe('150000');
      expect(by('M06')['outstanding_fines_paisa']).toBe('30000');
      expect(by('M02')['outstanding_fines_paisa']).toBe('0');
      expect(by('M08')['outstanding_fines_paisa']).toBe('0');

      expect(items.filter((i) => i['under_verification'] === true).map((i) => i.code)).toEqual([
        'M04',
      ]);
    },
  );

  dbIt('filters by status and rejects an unknown one', async () => {
    await q(`UPDATE members SET status = 'suspended' WHERE id = $1`, [m.M08]);
    try {
      const { items } = (await get('/members?status=suspended', token.M02)).json() as {
        items: Array<{ code: string }>;
      };
      expect(items.map((i) => i.code)).toEqual(['M08']);
      expect((await get('/members?status=banned', token.M02)).statusCode).toBe(400);
    } finally {
      await q(`UPDATE members SET status = 'active' WHERE id = $1`, [m.M08]);
    }
  });
});

describe('GET /members/:id', () => {
  dbIt('gives the cashier the full picture of a member', async () => {
    const res = await get(`/members/${m.M03}`, token.M01);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      code: 'M03',
      phone: '+8801700000003',
      shares: 1,
      capital_paisa: '500000',
      status: 'active',
    });
    expect(body.dues).toHaveLength(2);
    expect(body.dues.map((d: { period: string }) => d.period)).toEqual(['2026-11', '2026-10']);
    expect(body.dues.find((d: { period: string }) => d.period === '2026-10')).toMatchObject({
      status: 'paid',
      amount_paisa: '500000',
      allocated_paisa: '500000',
      outstanding_paisa: '0',
    });
    expect(body.share_holdings).toHaveLength(1);
    expect(body.share_register).toHaveLength(1);
    expect(body.fines).toEqual([]);
    expect(body.payments.items).toHaveLength(1);
    expect(body.payments.has_more).toBe(false);
    expect(body.ledger.items).toHaveLength(1);
    expect(body.ledger.items[0]).toMatchObject({
      debit_account: 'BKASH',
      credit_account: 'MEMBER_CAPITAL',
      amount_paisa: '500000',
      entry_date: '2026-10-10',
    });
    expect(body.ledger.items[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.ledger.items[0].seq).toMatch(/^\d+$/);
  });

  dbIt(
    'shows payment details to the payer, the cashier and the auditor, but not to other members',
    async () => {
      const detail = async (who: string) =>
        (await get(`/members/${m.M03}`, who)).json().payments.items[0] as Record<string, unknown>;

      for (const who of [token.M03, token.M01, token.M07]) {
        expect(await detail(who)).toMatchObject({ trx_id: 'TRX-ONE', note: 'paid by bKash' });
      }
      const other = await detail(token.M02);
      expect(other).toMatchObject({ status: 'confirmed', method: 'bkash', amount_paisa: '500000' });
      expect(other).not.toHaveProperty('trx_id');
      expect(other).not.toHaveProperty('note');
      expect(other).not.toHaveProperty('reject_reason');
    },
  );

  dbIt('never includes raw SMS text or proof files, for anyone', async () => {
    for (const who of [token.M03, token.M04, token.M01, token.M07, token.M02]) {
      for (const id of [m.M03, m.M04]) {
        const text = (await get(`/members/${id}`, who)).body;
        expect(text).not.toContain('secret sms text');
        expect(text).not.toContain('raw_sms');
        expect(text).not.toContain('proof_file_id');
      }
    }
  });

  dbIt('hides the phone of another member from a regular member, and shows your own', async () => {
    expect((await get(`/members/${m.M03}`, token.M02)).json().phone).toBeNull();
    expect((await get(`/members/${m.M03}`, token.M03)).json().phone).toBe('+8801700000003');
  });

  dbIt('returns 404 for an unknown member and 400 for a malformed id', async () => {
    const missing = await get('/members/00000000-0000-0000-0000-00000000dead', token.M02);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('member.not_found');
    expect((await get('/members/me', token.M02)).statusCode).toBe(400);
  });
});

describe('PATCH /members/me', () => {
  dbIt('merges notification preferences instead of replacing them', async () => {
    const res = await call('PATCH', '/members/me', token.M02, { notify_prefs: { digits: 'en' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().notify_prefs).toEqual({ push: true, sms: false, digits: 'en' });

    const again = await call('PATCH', '/members/me', token.M02, { notify_prefs: { sms: true } });
    expect(again.json().notify_prefs).toEqual({ push: true, sms: true, digits: 'en' });

    expect((await get('/me', token.M02)).json().notify_prefs).toEqual({
      push: true,
      sms: true,
      digits: 'en',
    });
  });

  dbIt('sets and removes a photo, accepting only an image the member uploaded', async () => {
    const file = async (mime: string, owner: string, n: string) =>
      (
        (await q(
          `INSERT INTO files (sha256, mime, size_bytes, path, created_by)
           VALUES (repeat($3,64), $1, 10, '/data/x', $2) RETURNING id`,
          [mime, owner, n],
        )) as [{ id: string }]
      )[0].id;
    const imageId = await file('image/jpeg', fund.users.M03, 'a');
    const pdfId = await file('application/pdf', fund.users.M03, 'b');
    const othersImage = await file('image/jpeg', fund.users.M02, 'c');

    // Someone else's file looks exactly like a missing one.
    const notYours = await call('PATCH', '/members/me', token.M03, { photo_file_id: othersImage });
    expect(notYours.statusCode).toBe(404);
    expect(notYours.json().code).toBe('file.not_found');

    const notImage = await call('PATCH', '/members/me', token.M03, { photo_file_id: pdfId });
    expect(notImage.statusCode).toBe(400);
    expect(notImage.json().code).toBe('member.photo_not_image');

    const unknown = await call('PATCH', '/members/me', token.M03, {
      photo_file_id: '00000000-0000-0000-0000-00000000dead',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('file.not_found');

    const ok = await call('PATCH', '/members/me', token.M03, { photo_file_id: imageId });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().photo_file_id).toBe(imageId);
    expect(
      (await get('/members', token.M02))
        .json()
        .items.find((i: { code: string }) => i.code === 'M03').photo_file_id,
    ).toBe(imageId);

    const removed = await call('PATCH', '/members/me', token.M03, { photo_file_id: null });
    expect(removed.json().photo_file_id).toBeNull();
  });

  dbIt("only ever changes the caller's own row", async () => {
    const before = await q(`SELECT notify_prefs FROM members WHERE id = $1`, [m.M04]);
    await call('PATCH', '/members/me', token.M02, { notify_prefs: { push: false } });
    expect(await q(`SELECT notify_prefs FROM members WHERE id = $1`, [m.M04])).toEqual(before);
  });

  dbIt('rejects an empty update and invalid values', async () => {
    const empty = await call('PATCH', '/members/me', token.M02, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('member.nothing_to_update');
    expect(
      (await call('PATCH', '/members/me', token.M02, { notify_prefs: { digits: 'fr' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('PATCH', '/members/me', token.M02, { photo_file_id: 'nope' })).statusCode,
    ).toBe(400);
  });

  dbIt(
    'is allowed for a suspended (read-only) member and is written to the audit log',
    async () => {
      await q(`UPDATE members SET status = 'suspended' WHERE id = $1`, [m.M04]);
      try {
        const res = await call('PATCH', '/members/me', token.M04, {
          notify_prefs: { digits: 'en' },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await q(`UPDATE members SET status = 'active' WHERE id = $1`, [m.M04]);
      }
      const audit = await q(
        `SELECT actor_user_id, before, after FROM audit_log WHERE action = 'member.update_profile' AND entity_id = $1`,
        [m.M04],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_user_id: fund.users.M04,
        before: { notify_prefs: { digits: 'bn' } },
        after: { notify_prefs: { digits: 'en' } },
      });
    },
  );
});

describe('PUT /members/:id/photo', () => {
  dbIt('lets the cashier add and remove a member photo with their own upload, and audits it', async () => {
    const file = async (owner: string, n: string) =>
      (
        (await q(
          `INSERT INTO files (sha256, mime, size_bytes, path, created_by)
           VALUES (repeat($2,64), 'image/jpeg', 10, '/data/x', $1) RETURNING id`,
          [owner, n],
        )) as [{ id: string }]
      )[0].id;
    const cashiers = await file(fund.users.M01, 'd');
    const members = await file(fund.users.M06, 'e');

    // Only the cashier, and only with an image the cashier uploaded.
    expect((await call('PUT', `/members/${m.M06}/photo`, token.M02, { photo_file_id: cashiers })).statusCode).toBe(403);
    const notYours = await call('PUT', `/members/${m.M06}/photo`, token.M01, { photo_file_id: members });
    expect(notYours.statusCode).toBe(404);
    expect(notYours.json().code).toBe('file.not_found');
    const noMember = await call('PUT', '/members/00000000-0000-0000-0000-00000000dead/photo', token.M01, { photo_file_id: cashiers });
    expect(noMember.json().code).toBe('member.not_found');

    const set = await call('PUT', `/members/${m.M06}/photo`, token.M01, { photo_file_id: cashiers });
    expect(set.statusCode).toBe(200);
    expect((await get(`/members/${m.M06}`, token.M02)).json().photo_file_id).toBe(cashiers);
    const matrixRow = (await get('/matrix', token.M02)).json().members.find((r: { member_code: string }) => r.member_code === 'M06');
    expect(matrixRow.member_photo_file_id).toBe(cashiers);

    const removed = await call('PUT', `/members/${m.M06}/photo`, token.M01, { photo_file_id: null });
    expect(removed.json().photo_file_id).toBeNull();

    const audit = await q(
      `SELECT actor_user_id, before, after FROM audit_log WHERE action = 'member.set_photo' AND entity_id = $1 ORDER BY id`,
      [m.M06],
    );
    expect(audit).toEqual([
      { actor_user_id: fund.users.M01, before: { photo_file_id: null }, after: { photo_file_id: cashiers } },
      { actor_user_id: fund.users.M01, before: { photo_file_id: cashiers }, after: { photo_file_id: null } },
    ]);
  });
});

describe('PATCH /members/:id/contact', () => {
  dbIt('lets the cashier correct a name and phone, and audits the old and new values', async () => {
    const res = await call('PATCH', `/members/${m.M05}/contact`, token.M01, {
      full_name: '  Corrected Name ',
      phone: '+8801799999995',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      code: 'M05',
      full_name: 'Corrected Name',
      phone: '+8801799999995',
    });

    const detail = (await get(`/members/${m.M05}`, token.M01)).json();
    expect(detail).toMatchObject({ full_name: 'Corrected Name', phone: '+8801799999995' });

    const audit = await q(
      `SELECT actor_user_id, before, after FROM audit_log WHERE action = 'member.update_contact' AND entity_id = $1`,
      [m.M05],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: fund.users.M01,
      before: { full_name: 'Member M05', phone: '+8801700000005' },
      after: { full_name: 'Corrected Name', phone: '+8801799999995' },
    });
  });

  dbIt('can change just one field', async () => {
    const res = await call('PATCH', `/members/${m.M06}/contact`, token.M01, {
      full_name: 'Only Name',
    });
    expect(res.json()).toMatchObject({ full_name: 'Only Name', phone: '+8801700000006' });
  });

  dbIt('is cashier only: members and the auditor get 403', async () => {
    for (const who of [token.M02, token.M07]) {
      const res = await call('PATCH', `/members/${m.M06}/contact`, who, { full_name: 'Hacked' });
      expect(res.statusCode).toBe(403);
    }
    expect((await q(`SELECT full_name FROM members WHERE id = $1`, [m.M06]))[0]).toMatchObject({
      full_name: 'Only Name',
    });
  });

  dbIt('rejects a phone another member already has, and changes nothing', async () => {
    const res = await call('PATCH', `/members/${m.M06}/contact`, token.M01, {
      full_name: 'Should Not Stick',
      phone: '+8801700000004',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('member.phone_taken');
    expect((await q(`SELECT full_name FROM members WHERE id = $1`, [m.M06]))[0]).toMatchObject({
      full_name: 'Only Name',
    });
  });

  dbIt(
    'validates the phone format, needs at least one field and 404s an unknown member',
    async () => {
      expect(
        (await call('PATCH', `/members/${m.M06}/contact`, token.M01, { phone: '01700000099' }))
          .statusCode,
      ).toBe(400);
      const empty = await call('PATCH', `/members/${m.M06}/contact`, token.M01, {});
      expect(empty.json().code).toBe('member.nothing_to_update');
      const missing = await call(
        'PATCH',
        '/members/00000000-0000-0000-0000-00000000dead/contact',
        token.M01,
        {
          full_name: 'x',
        },
      );
      expect(missing.statusCode).toBe(404);
    },
  );
});

describe('GET /share-register and /share-holdings', () => {
  dbIt('lists one register row per share, in share order, with nominee details', async () => {
    const body = (await get('/share-register', token.M02)).json();
    expect(body.total).toBe(20);
    expect(body.items.map((i: { share_no: number }) => i.share_no)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(body.items[0]).toMatchObject({
      share_no: 1,
      member_code: 'M01',
      registered_name: 'Share 1',
      nominee_name: 'Nominee 1',
      nominee_relation: 'son',
    });
    expect(body.items.filter((i: { member_code: string }) => i.member_code === 'M02')).toHaveLength(
      4,
    );
    // The register carries no phone numbers.
    expect(JSON.stringify(body)).not.toContain('+8801');
  });

  dbIt('lists the holdings in force on a date, end exclusive, with the total', async () => {
    // M02 swaps its 4 shares for 5 on 1 December.
    await q(`UPDATE share_holdings SET effective_to = '2026-12-01' WHERE member_id = $1`, [m.M02]);
    await q(
      `INSERT INTO share_holdings (member_id, shares, effective_from, source)
       VALUES ($1, 5, '2026-12-01', 'transfer_in')`,
      [m.M02],
    );

    const today = (await get('/share-holdings', token.M02)).json();
    expect(today).toMatchObject({ as_of: '2026-11-05', total_shares: 20 });
    expect(today.items).toHaveLength(8);

    const lastDay = (await get('/share-holdings?as_of=2026-11-30', token.M02)).json();
    expect(lastDay.total_shares).toBe(20);
    const swapDay = (await get('/share-holdings?as_of=2026-12-01', token.M02)).json();
    expect(swapDay.total_shares).toBe(21);
    expect(
      swapDay.items.find((i: { member_code: string }) => i.member_code === 'M02'),
    ).toMatchObject({ shares: 5 });
    expect((await get('/share-holdings?as_of=2025-12-31', token.M02)).json()).toMatchObject({
      items: [],
      total_shares: 0,
    });
  });

  dbIt('returns the full history of a member, ended rows included', async () => {
    const body = (await get(`/share-holdings?member_id=${m.M02}&history=true`, token.M02)).json();
    expect(body.as_of).toBeNull();
    expect(body.total_shares).toBeNull();
    expect(
      body.items.map((i: { shares: number; effective_to: string | null }) => [
        i.shares,
        i.effective_to,
      ]),
    ).toEqual([
      [4, '2026-12-01'],
      [5, null],
    ]);
    // `history=false` really means false.
    const inForce = (
      await get(`/share-holdings?member_id=${m.M02}&history=false`, token.M02)
    ).json();
    expect(inForce.items).toHaveLength(1);
    expect((await get('/share-holdings?history=maybe', token.M02)).statusCode).toBe(400);
    expect((await get('/share-holdings?as_of=2026-02-30', token.M02)).statusCode).toBe(400);
  });
});

describe('GET /rules', () => {
  dbIt('returns the rules in force today, one per key, with their clause references', async () => {
    const body = (await get('/rules', token.M02)).json();
    expect(body.as_of).toBe('2026-11-05');
    const keys = body.items.map((i: { key: string }) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    const rule = (key: string) => body.items.find((i: { key: string }) => i.key === key);
    expect(rule('monthly_due_per_share_paisa')).toMatchObject({
      value: 500000,
      valid_from: '2026-01-01',
      clause_ref: '1.4',
    });
    expect(rule('due_day')).toMatchObject({ value: 20 });
    expect(rule('fund_term_start')).toMatchObject({ value: '2026-01-01', clause_ref: '1.2' });
    expect(rule('fund_term_end')).toMatchObject({ value: '2028-12-31', clause_ref: '1.2' });
  });

  dbIt('answers for a past or future date using valid_from', async () => {
    await q(
      `INSERT INTO rules (key, value, valid_from, clause_ref)
       VALUES ('monthly_due_per_share_paisa', '600000', '2026-12-01', '1.4')`,
    );
    const value = async (qs: string) =>
      (await get(`/rules?key=monthly_due_per_share_paisa${qs}`, token.M02)).json().items[0]?.value;
    expect(await value('')).toBe(500000);
    expect(await value('&as_of=2026-11-30')).toBe(500000);
    expect(await value('&as_of=2026-12-01')).toBe(600000);
    expect((await get('/rules?as_of=2025-12-31', token.M02)).json().items).toEqual([]);
  });

  dbIt('lists every version of a rule on request, newest first', async () => {
    const body = (
      await get('/rules?key=monthly_due_per_share_paisa&history=true', token.M02)
    ).json();
    expect(body.as_of).toBeNull();
    expect(body.items.map((i: { valid_from: string }) => i.valid_from)).toEqual([
      '2026-12-01',
      '2026-01-01',
    ]);
    expect((await get('/rules?as_of=soon', token.M02)).statusCode).toBe(400);
  });
});

describe('GET /accounts/balances', () => {
  dbIt('returns the whole chart of accounts in chart order, assets first', async () => {
    const { items } = (await get('/accounts/balances', token.M02)).json() as {
      items: Array<Record<string, unknown>>;
    };
    expect(items.map((i) => i['code'])).toEqual([...ACCOUNT_CODES]);
    expect(items.slice(0, 4).map((i) => [i['code'], i['is_cash']])).toEqual([
      ['CASH', true],
      ['BANK', true],
      ['BKASH', true],
      ['NAGAD', true],
    ]);
    expect(items.filter((i) => i['retired']).map((i) => i['code'])).toEqual(['FINE_INCOME']);
  });

  dbIt('reports raw and natural balances from the ledger as digit strings', async () => {
    const { items } = (await get('/accounts/balances', token.M02)).json() as {
      items: Array<Record<string, unknown> & { code: string }>;
    };
    const acct = (code: string) => items.find((i) => i.code === code)!;
    // M03's 500000 went DR BKASH, CR MEMBER_CAPITAL.
    expect(acct('BKASH')).toMatchObject({
      kind: 'asset',
      balance_paisa: '500000',
      natural_balance_paisa: '500000',
    });
    expect(acct('MEMBER_CAPITAL')).toMatchObject({
      kind: 'equity',
      balance_paisa: '-500000',
      natural_balance_paisa: '500000',
    });
    expect(acct('CASH')).toMatchObject({ balance_paisa: '0', natural_balance_paisa: '0' });
  });
});

describe('GET /dues', () => {
  type Due = Record<string, unknown> & {
    id: string;
    member_id: string;
    period: string;
    due_date: string;
  };
  const dues = async (qs: string) =>
    (await get(`/dues${qs}`, token.M02)).json() as { items: Due[]; next_cursor: string | null };

  dbIt('lists dues with derived status and amounts as digit strings', async () => {
    const { items, next_cursor } = await dues('?limit=200');
    expect(items).toHaveLength(16);
    expect(next_cursor).toBeNull();
    const m03Oct = items.find((i) => i.member_id === m.M03 && i.period === '2026-10')!;
    expect(m03Oct).toMatchObject({
      member_code: 'M03',
      kind: 'monthly',
      shares_snapshot: 1,
      amount_paisa: '500000',
      allocated_paisa: '500000',
      outstanding_paisa: '0',
      due_date: '2026-10-20',
      status: 'paid',
    });
    const m02Nov = items.find((i) => i.member_id === m.M02 && i.period === '2026-11')!;
    expect(m02Nov).toMatchObject({
      amount_paisa: '2000000',
      allocated_paisa: '0',
      due_date: '2026-11-20',
    });
  });

  dbIt('filters by period, member and status', async () => {
    expect((await dues('?period=2026-11')).items).toHaveLength(8);
    expect((await dues(`?member_id=${m.M01}`)).items.map((i) => i.period)).toEqual([
      '2026-11',
      '2026-10',
    ]);
    const paid = (await dues('?status=paid')).items;
    expect(paid.map((i) => [i.member_id, i.period])).toEqual([[m.M03, '2026-10']]);
    expect((await get('/dues?period=2026-13', token.M02)).statusCode).toBe(400);
    expect((await get('/dues?status=late', token.M02)).statusCode).toBe(400);
  });

  dbIt(
    'marks the dues of a member with a payment waiting for the cashier as under verification',
    async () => {
      const { items } = await dues('?limit=200');
      const flagged = items.filter((i) => i['under_verification'] === true);
      expect(flagged.length).toBeGreaterThan(0);
      expect(new Set(flagged.map((i) => i.member_id))).toEqual(new Set([m.M04]));
      // Only a month that is already due can be what the waiting payment is for; a month still to
      // come is not flagged just because the member has some payment with the cashier.
      const today = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10);
      const open = items.filter((i) => i.member_id === m.M04 && i['outstanding_paisa'] !== '0');
      expect(open).toHaveLength(2);
      for (const i of open) expect(i['under_verification']).toBe(i.due_date <= today);
      // A paid due is never "under verification", even for a member with a pending payment.
      expect(
        items.find((i) => i.member_id === m.M03 && i.period === '2026-10')?.['under_verification'],
      ).toBe(false);
    },
  );

  dbIt('pages with cursors: no row twice, none missed, newest first', async () => {
    const seen: string[] = [];
    const dates: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: Due[]; next_cursor: string | null } = await dues(
        `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(5);
      seen.push(...page.items.map((i) => i.id));
      dates.push(...page.items.map((i) => i.due_date));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(16);
    expect(new Set(seen).size).toBe(16);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  dbIt('rejects a bad cursor and an out-of-range limit', async () => {
    const bad = await get('/dues?cursor=not-a-cursor', token.M02);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('request.invalid_cursor');
    expect((await get('/dues?limit=0', token.M02)).statusCode).toBe(400);
    expect((await get('/dues?limit=201', token.M02)).statusCode).toBe(400);
  });
});

describe('GET /fines', () => {
  type Fine = Record<string, unknown> & { id: string; member_code: string };
  const fines = async (qs = '') =>
    (await get(`/fines${qs}`, token.M02)).json() as { items: Fine[]; next_cursor: string | null };

  dbIt('lists fines with their derived status and outstanding amount', async () => {
    const { items } = await fines();
    const byMember = Object.fromEntries(items.map((i) => [i.member_code, i]));
    expect(byMember['M05']).toMatchObject({
      status: 'unpaid',
      kind: 'late_payment',
      period: '2026-10',
      amount_paisa: '150000',
      allocated_paisa: '0',
      outstanding_paisa: '150000',
    });
    expect(byMember['M06']).toMatchObject({
      status: 'partial',
      allocated_paisa: '20000',
      outstanding_paisa: '30000',
    });
    expect(byMember['M08']).toMatchObject({ status: 'paid', outstanding_paisa: '0' });
    expect(byMember['M02']).toMatchObject({ status: 'waived', outstanding_paisa: '0' });
    expect(byMember['M02']?.['waived_at']).toBeTruthy();
    expect(items).toHaveLength(4);
  });

  dbIt('filters by status and by member', async () => {
    for (const [status, code] of [
      ['unpaid', 'M05'],
      ['partial', 'M06'],
      ['paid', 'M08'],
      ['waived', 'M02'],
    ] as const) {
      expect((await fines(`?status=${status}`)).items.map((i) => i.member_code)).toEqual([code]);
    }
    expect((await fines(`?member_id=${m.M05}`)).items).toHaveLength(1);
    expect((await get('/fines?status=open', token.M02)).statusCode).toBe(400);
  });

  dbIt('pages with cursors without repeating or skipping a fine', async () => {
    const first = await fines('?limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.next_cursor).toBeTruthy();
    const second = await fines(`?limit=3&cursor=${encodeURIComponent(first.next_cursor!)}`);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(4);
  });
});
