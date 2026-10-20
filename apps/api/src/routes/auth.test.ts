import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { createFakeClock } from '@barakah/shared';
import { buildApp } from '../app';
import { parseEnv, type Env } from '../lib/env';
import { createTestDb, type TestDb } from '../test/db-harness';
import { issueActivationCode } from '../auth/service';

const env: Env = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PUBLIC_ORIGIN: 'https://fund.example',
  APP_ENCRYPTION_KEY: 'ab'.repeat(32),
  JWT_SECRET: 'j'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(20),
  INTERNAL_ALERT_SECRET: 'a'.repeat(20),
  LOG_LEVEL: 'silent',
  AUTH_RATE_LIMIT_PER_MINUTE: '100000',
  RATE_LIMIT_PER_MINUTE: '100000',
});

const GOOD_PIN = '483917';
const clock = createFakeClock(new Date());

let db: TestDb | null;
let app: FastifyInstance;
const ids: Record<string, string> = {}; // member code -> member id

async function addMember(code: string, phone: string, roles: string[]) {
  const m = await db!.admin.query(
    `INSERT INTO members (code, full_name, phone, joined_on) VALUES ($1,$2,$3,'2026-01-01') RETURNING id`,
    [code, `Member ${code}`, phone],
  );
  const memberId = (m.rows[0] as { id: string }).id;
  await db!.admin.query(`INSERT INTO users (member_id, roles) VALUES ($1, $2)`, [memberId, roles]);
  ids[code] = memberId;
}

const device = (install = 'install-1') => ({ label: 'Test phone', platform: 'android', install_id: install });

async function code(memberCode: string, mode: 'replace' | 'add' = 'replace'): Promise<string> {
  const u = await db!.admin.query(
    `SELECT u.id FROM users u JOIN members m ON m.id=u.member_id WHERE m.code='M01'`,
  );
  const issued = await issueActivationCode(
    db!.app,
    { env, clock },
    ids[memberCode]!,
    mode,
    (u.rows[0] as { id: string }).id,
    {},
  );
  return issued.code;
}

const post = (url: string, body: unknown, token?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload: body as object,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

const get = (url: string, token: string) =>
  app.inject({ url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

async function activateMember(memberCode: string, install = 'install-1', mode: 'replace' | 'add' = 'replace') {
  const res = await post('/auth/activate', {
    member_ref: memberCode,
    code: await code(memberCode, mode),
    device: device(install),
    pin: GOOD_PIN,
  });
  return res;
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env, db: db.app, clock });
  await addMember('M01', '+8801700000001', ['member', 'cashier']);
  await addMember('M02', '+8801700000002', ['member']);
  await addMember('M03', '+8801700000003', ['member']);
  await addMember('M04', '+8801700000004', ['member']);
  await addMember('M05', '+8801700000005', ['member']);
  await addMember('M06', '+8801700000006', ['member']);
  await addMember('M07', '+8801700000007', ['member', 'auditor']);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('activation', () => {
  it('activates with a valid code, returns a session and records device events', async (ctx) => {
    if (!db) return ctx.skip();
    const res = await activateMember('M02');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.device_id).toBeTruthy();

    const me = await get('/me', body.access_token);
    expect(me.json()).toMatchObject({ member_code: 'M02', roles: ['member'], read_only: false });

    const events = await get('/device-events', body.access_token);
    expect(events.json().items[0]).toMatchObject({ kind: 'registered', member_code: 'M02' });
  });

  it('never stores the PIN or the activation code in clear', async (ctx) => {
    if (!db) return ctx.skip();
    const plain = await code('M03');
    await post('/auth/activate', { member_ref: 'M03', code: plain, device: device('i3'), pin: GOOD_PIN });
    const user = await db.admin.query(
      `SELECT pin_hash FROM users u JOIN members m ON m.id=u.member_id WHERE m.code='M03'`,
    );
    expect((user.rows[0] as { pin_hash: string }).pin_hash).not.toContain(GOOD_PIN);
    expect((user.rows[0] as { pin_hash: string }).pin_hash).toMatch(/^\$argon2id\$/);
    const codes = await db.admin.query(`SELECT code_hash FROM activation_codes`);
    for (const r of codes.rows as Array<{ code_hash: string }>) expect(r.code_hash).not.toBe(plain);
    const audit = await db.admin.query(`SELECT before, after FROM audit_log`);
    expect(JSON.stringify(audit.rows)).not.toContain(GOOD_PIN);
    expect(JSON.stringify(audit.rows)).not.toContain(plain);
  });

  it('is single use', async (ctx) => {
    if (!db) return ctx.skip();
    const plain = await code('M04');
    const body = { member_ref: 'M04', code: plain, device: device('i4'), pin: GOOD_PIN };
    expect((await post('/auth/activate', body)).statusCode).toBe(200);
    const again = await post('/auth/activate', body);
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe('auth.invalid_activation');
  });

  it('expires after 24 hours', async (ctx) => {
    if (!db) return ctx.skip();
    const plain = await code('M05');
    clock.advance(24 * 3600_000 + 1000);
    const res = await post('/auth/activate', {
      member_ref: 'M05',
      code: plain,
      device: device('i5'),
      pin: GOOD_PIN,
    });
    expect(res.json().code).toBe('auth.invalid_activation');
    clock.advance(-(24 * 3600_000 + 1000));
  });

  it('locks the code after 5 wrong attempts, even for the right code', async (ctx) => {
    if (!db) return ctx.skip();
    const plain = await code('M05');
    const wrong = plain === '0000AAAA' ? '0000BBBB' : '0000AAAA';
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/activate', {
        member_ref: 'M05',
        code: wrong,
        device: device('i5'),
        pin: GOOD_PIN,
      });
      expect(r.json().code).toBe('auth.invalid_activation');
    }
    const res = await post('/auth/activate', {
      member_ref: 'M05',
      code: plain,
      device: device('i5'),
      pin: GOOD_PIN,
    });
    expect(res.statusCode).toBe(423);
    expect(res.json().code).toBe('auth.activation_locked');
  });

  it('a new code invalidates the earlier one', async (ctx) => {
    if (!db) return ctx.skip();
    const first = await code('M05');
    const second = await code('M05');
    const old = await post('/auth/activate', {
      member_ref: 'M05',
      code: first,
      device: device('i5'),
      pin: GOOD_PIN,
    });
    expect(old.statusCode).toBe(401);
    const fresh = await post('/auth/activate', {
      member_ref: 'M05',
      code: second,
      device: device('i5'),
      pin: GOOD_PIN,
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('rejects weak PINs', async (ctx) => {
    if (!db) return ctx.skip();
    const res = await post('/auth/activate', {
      member_ref: 'M06',
      code: await code('M06'),
      device: device('i6'),
      pin: '123456',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('login, lockout and devices', () => {
  let deviceId: string;

  it('logs in with PIN on the registered device', async (ctx) => {
    if (!db) return ctx.skip();
    const act = (await activateMember('M06', 'i6')).json();
    deviceId = act.device_id;
    const res = await post('/auth/login', { member_ref: 'M06', pin: GOOD_PIN, device_id: deviceId });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBeTruthy();
  });

  it('gives the same error for an unknown member and a wrong PIN', async (ctx) => {
    if (!db) return ctx.skip();
    const unknown = await post('/auth/login', { member_ref: 'M99', pin: GOOD_PIN, device_id: deviceId });
    const wrong = await post('/auth/login', { member_ref: 'M06', pin: '000111', device_id: deviceId });
    expect(unknown.json().code).toBe('auth.invalid_credentials');
    expect(wrong.json().code).toBe('auth.invalid_credentials');
  });

  it('locks for 15 minutes after 5 wrong PINs and the cashier can unlock', async (ctx) => {
    if (!db) return ctx.skip();
    for (let i = 0; i < 4; i++) {
      await post('/auth/login', { member_ref: 'M06', pin: '000111', device_id: deviceId });
    }
    const locked = await post('/auth/login', { member_ref: 'M06', pin: '000111', device_id: deviceId });
    expect(locked.statusCode).toBe(423);
    // the right PIN is refused while locked
    const still = await post('/auth/login', { member_ref: 'M06', pin: GOOD_PIN, device_id: deviceId });
    expect(still.statusCode).toBe(423);

    // cashier unlock
    const cashier = (await activateMember('M01', 'cashier-phone')).json();
    const unlock = await post(`/members/${ids.M06}/unlock`, {}, cashier.access_token);
    expect(unlock.statusCode).toBe(204);
    const ok = await post('/auth/login', { member_ref: 'M06', pin: GOOD_PIN, device_id: deviceId });
    expect(ok.statusCode).toBe(200);
  });

  it('the lock expires by itself after 15 minutes', async (ctx) => {
    if (!db) return ctx.skip();
    for (let i = 0; i < 5; i++) {
      await post('/auth/login', { member_ref: 'M06', pin: '000111', device_id: deviceId });
    }
    clock.advance(15 * 60_000 + 1000);
    const ok = await post('/auth/login', { member_ref: 'M06', pin: GOOD_PIN, device_id: deviceId });
    expect(ok.statusCode).toBe(200);
  });

  it('a regular member cannot use cashier endpoints', async (ctx) => {
    if (!db) return ctx.skip();
    const s = (await post('/auth/login', { member_ref: 'M06', pin: GOOD_PIN, device_id: deviceId })).json();
    const res = await post(`/members/${ids.M06}/unlock`, {}, s.access_token);
    expect(res.statusCode).toBe(403);
  });
});

describe('device policy', () => {
  it('a regular member cannot add a second device (auth.device_limit)', async (ctx) => {
    if (!db) return ctx.skip();
    await activateMember('M02', 'phone-a'); // replaces whatever was there
    const res = await activateMember('M02', 'phone-b', 'add');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('auth.device_limit');
  });

  it('the privileged cashier may add a second device, but not a third', async (ctx) => {
    if (!db) return ctx.skip();
    await activateMember('M01', 'cashier-phone');
    expect((await activateMember('M01', 'cashier-desktop', 'add')).statusCode).toBe(200);
    expect((await activateMember('M01', 'cashier-third', 'add')).statusCode).toBe(409);
  });

  it('replacement revokes old devices and refresh tokens, and shows in the security feed', async (ctx) => {
    if (!db) return ctx.skip();
    const first = (await activateMember('M02', 'old-phone')).json();
    const second = (await activateMember('M02', 'new-phone')).json();

    const oldLogin = await post('/auth/login', {
      member_ref: 'M02',
      pin: GOOD_PIN,
      device_id: first.device_id,
    });
    expect(oldLogin.json().code).toBe('auth.device_reset_needed');
    const oldRefresh = await post('/auth/refresh', {
      refresh_token: first.refresh_token,
      device_id: first.device_id,
    });
    expect(oldRefresh.statusCode).toBe(401);
    const oldAccess = await get('/me', first.access_token);
    expect(oldAccess.statusCode).toBe(401);

    const feed = await get('/device-events', second.access_token);
    const kinds = (feed.json().items as Array<{ kind: string; member_code: string }>)
      .filter((e) => e.member_code === 'M02')
      .map((e) => e.kind);
    expect(kinds).toContain('reset');
    expect(kinds).toContain('registered');
  });
});

describe('refresh tokens', () => {
  it('rotates on every use and revokes the device when an old token is replayed', async (ctx) => {
    if (!db) return ctx.skip();
    const s = (await activateMember('M02', 'rot-phone')).json();
    const r1 = await post('/auth/refresh', { refresh_token: s.refresh_token, device_id: s.device_id });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().refresh_token).not.toBe(s.refresh_token);

    const replay = await post('/auth/refresh', { refresh_token: s.refresh_token, device_id: s.device_id });
    expect(replay.json().code).toBe('auth.refresh_reuse');

    // even the legitimately rotated token is now dead: the device was revoked
    const after = await post('/auth/refresh', {
      refresh_token: r1.json().refresh_token,
      device_id: s.device_id,
    });
    expect(after.statusCode).toBe(401);
  });

  it('logout invalidates the refresh token but the device keeps PIN login', async (ctx) => {
    if (!db) return ctx.skip();
    const s = (await activateMember('M02', 'lo-phone')).json();
    expect((await post('/auth/logout', {}, s.access_token)).statusCode).toBe(204);
    const r = await post('/auth/refresh', { refresh_token: s.refresh_token, device_id: s.device_id });
    expect(r.statusCode).toBe(401);
    const l = await post('/auth/login', { member_ref: 'M02', pin: GOOD_PIN, device_id: s.device_id });
    expect(l.statusCode).toBe(200);
  });
});

describe('TOTP and step-up', () => {
  it('requires enrolment and then a code before an activation code can be created', async (ctx) => {
    if (!db) return ctx.skip();
    const cashier = (await activateMember('M01', 'totp-phone')).json();
    const token = cashier.access_token as string;

    const before = await post(`/members/${ids.M07}/activation-code`, {}, token);
    expect(before.statusCode).toBe(403);
    expect(before.json().code).toBe('auth.totp_enrollment_required');

    const enrol = (await post('/auth/totp/enroll', {}, token)).json();
    expect(enrol.otpauth_url).toContain('otpauth://totp/');

    // enrolled but not yet verified
    const unverified = await post(`/members/${ids.M07}/activation-code`, {}, token);
    expect(unverified.json().code).toBe('auth.totp_enrollment_required');

    const bad = await post('/auth/totp/verify', { code: '000000' }, token);
    expect(bad.json().code).toBe('auth.totp_invalid');

    authenticator.options = { epoch: clock.now().getTime() };
    const goodCode = authenticator.generate(enrol.secret);
    authenticator.options = {};
    expect((await post('/auth/totp/verify', { code: goodCode }, token)).statusCode).toBe(200);

    const issued = await post(`/members/${ids.M07}/activation-code`, {}, token);
    expect(issued.statusCode).toBe(200);
    const body = issued.json();
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.qr_payload).toBe(`barakah://activate?ref=M07&code=${body.code}`);

    // the issued code works for the auditor
    const act = await post('/auth/activate', {
      member_ref: 'M07',
      code: body.code,
      device: device('auditor-phone'),
      pin: GOOD_PIN,
    });
    expect(act.statusCode).toBe(200);
  });

  it('step-up does not carry over to another device', async (ctx) => {
    if (!db) return ctx.skip();
    // The previous test left M01 with one stepped-up device; add the allowed second one.
    const second = await activateMember('M01', 'second-desk', 'add');
    expect(second.statusCode).toBe(200);
    const res = await post(`/members/${ids.M07}/activation-code`, {}, second.json().access_token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('auth.step_up_required');
  });

  it('regular members cannot enrol TOTP', async (ctx) => {
    if (!db) return ctx.skip();
    const s = (await activateMember('M02', 'plain-phone')).json();
    expect((await post('/auth/totp/enroll', {}, s.access_token)).statusCode).toBe(403);
  });
});

describe('access control', () => {
  it('rejects requests without a valid token', async (ctx) => {
    if (!db) return ctx.skip();
    expect((await app.inject('/api/v1/me')).statusCode).toBe(401);
    const bad = await app.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(bad.json().code).toBe('auth.unauthorized');
  });

  it('the application role cannot delete audit rows', async (ctx) => {
    if (!db) return ctx.skip();
    await expect(db.app.query('DELETE FROM audit_log')).rejects.toThrow();
  });
});
