import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Clock } from '@barakah/shared';
import { issueActivationCode } from '../auth/service';
import { parseEnv, type Env } from '../lib/env';
import type { TestDb } from './db-harness';

/** Environment for tests that build the app: no real secrets, no rate limits. */
export const testEnv: Env = parseEnv({
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
  UPLOAD_RATE_LIMIT_PER_MINUTE: '100000',
});

/** The spec 14.2 fixture: eight fictional members holding 20 shares. */
export const FIXTURE_SHARES = [2, 4, 1, 1, 3, 1, 4, 4] as const;
export const FIXTURE_CODES = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08'] as const;
export type FixtureCode = (typeof FIXTURE_CODES)[number];

export interface Fund {
  /** member code -> member id */
  members: Record<FixtureCode, string>;
  /** member code -> user id */
  users: Record<FixtureCode, string>;
}

/**
 * Insert the fixture: M01 is the cashier, M07 the auditor, everyone holds shares from 2026-01-01
 * and the register has one row per share. Fake names and phones only (spec 0.4).
 */
export async function seedFund(admin: pg.Pool): Promise<Fund> {
  const members = {} as Record<FixtureCode, string>;
  const users = {} as Record<FixtureCode, string>;
  let shareNo = 1;
  for (const [i, code] of FIXTURE_CODES.entries()) {
    const shares = FIXTURE_SHARES[i] as number;
    const m = await admin.query(
      `INSERT INTO members (code, full_name, phone, joined_on)
       VALUES ($1, $2, $3, '2026-01-01') RETURNING id`,
      [code, `Member ${code}`, `+880170000000${i + 1}`],
    );
    const memberId = (m.rows[0] as { id: string }).id;
    const roles =
      code === 'M01' ? ['member', 'cashier'] : code === 'M07' ? ['member', 'auditor'] : ['member'];
    const u = await admin.query(
      `INSERT INTO users (member_id, roles) VALUES ($1, $2) RETURNING id`,
      [memberId, roles],
    );
    await admin.query(
      `INSERT INTO share_holdings (member_id, shares, effective_from, source)
       VALUES ($1, $2, '2026-01-01', 'initial')`,
      [memberId, shares],
    );
    for (let j = 0; j < shares; j++, shareNo++) {
      await admin.query(
        `INSERT INTO share_register (share_no, member_id, registered_name, nominee_name, nominee_relation)
         VALUES ($1, $2, $3, $4, 'son')`,
        [shareNo, memberId, `Share ${shareNo}`, `Nominee ${shareNo}`],
      );
    }
    members[code] = memberId;
    users[code] = (u.rows[0] as { id: string }).id;
  }
  return { members, users };
}

export const GOOD_PIN = '483917';

export interface TestSession {
  access_token: string;
  refresh_token: string;
  device_id: string;
}

/** Activate a member through the real API and return their access token. */
export async function activateAndLogin(
  app: FastifyInstance,
  db: TestDb,
  clock: Clock,
  fund: Fund,
  code: FixtureCode,
): Promise<string> {
  return (await activateSession(app, db, clock, fund, code)).access_token;
}

/** Activate a member through the real API and return the whole session. */
export async function activateSession(
  app: FastifyInstance,
  db: TestDb,
  clock: Clock,
  fund: Fund,
  code: FixtureCode,
): Promise<TestSession> {
  const issued = await issueActivationCode(
    db.app,
    { env: testEnv, clock },
    fund.members[code],
    'replace',
    fund.users.M01,
    {},
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/activate',
    payload: {
      member_ref: code,
      code: issued.code,
      device: { label: 'Test phone', platform: 'android', install_id: `install-${code}` },
      pin: GOOD_PIN,
    },
  });
  if (res.statusCode !== 200) throw new Error(`activation of ${code} failed: ${res.body}`);
  return res.json() as TestSession;
}

/** Insert a confirmed payment that has not been allocated to anything (member credit). */
export async function addConfirmedPayment(
  admin: pg.Pool,
  memberId: string,
  amount: number,
  opts: {
    unallocated?: number;
    confirmedAt?: string;
    trxId?: string;
    method?: string;
    note?: string;
    rawSms?: string;
  } = {},
): Promise<string> {
  const res = await admin.query(
    `INSERT INTO payments (member_id, amount_paisa, method, paid_at, status, source, trx_id,
                           confirmed_at, unallocated_paisa, note, raw_sms)
     VALUES ($1, $2, $3, $4, 'confirmed', 'cashier_entry', $5, $4, $6, $7, $8) RETURNING id`,
    [
      memberId,
      amount,
      opts.method ?? 'cash',
      opts.confirmedAt ?? '2026-10-01T06:00:00Z',
      opts.trxId ?? null,
      opts.unallocated ?? amount,
      opts.note ?? null,
      opts.rawSms ?? null,
    ],
  );
  return (res.rows[0] as { id: string }).id;
}
