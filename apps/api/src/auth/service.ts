import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import type pg from 'pg';
import type { Activate, Clock, Login, Refresh } from '@barakah/shared';
import { AppError, conflict, forbidden, notFound, unauthorized } from '../lib/errors';
import {
  decryptSecret,
  encryptSecret,
  generateActivationCode,
  generateRefreshToken,
  hashToken,
  safeEqualHex,
} from '../lib/crypto';
import type { Env } from '../lib/env';
import { audit } from '../lib/audit';
import { inTransaction, type Db } from '../lib/tx';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
export const STEP_UP_TTL_MS = 12 * 3600_000;
export const ACTIVATION_CODE_TTL_MS = 24 * 3600_000;
export const ACTIVATION_MAX_ATTEMPTS = 5;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;

authenticator.options = { window: 1 };

export interface AuthDeps {
  pool: pg.Pool;
  env: Env;
  clock: Clock;
}

export interface ClientInfo {
  ip?: string | undefined;
}


export interface AuthUser {
  id: string;
  member_id: string;
  member_code: string;
  full_name: string;
  roles: string[];
  user_status: 'pending_activation' | 'active' | 'disabled';
  member_status: string;
  totp_enabled: boolean;
  device_id: string;
  step_up_at: Date | null;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device_id: string;
}

// ---- helpers ------------------------------------------------------------------------------

const hashPin = (pin: string, env: Env) =>
  argon2.hash(pin, { type: argon2.argon2id, secret: Buffer.from(env.TOKEN_PEPPER) });

const verifyPin = (hash: string, pin: string, env: Env) =>
  argon2.verify(hash, pin, { secret: Buffer.from(env.TOKEN_PEPPER) });

let dummyHash: Promise<string> | undefined;
/** Burn the same time as a real PIN check so unknown members cannot be told apart by latency. */
async function fakePinCheck(pin: string, env: Env): Promise<void> {
  dummyHash ??= hashPin('invalid-dummy-pin', env);
  await verifyPin(await dummyHash, pin, env).catch(() => false);
}

function signAccessToken(env: Env, userId: string, deviceId: string): string {
  return jwt.sign({ did: deviceId }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Rotate the device's refresh token and build the session response. */
async function issueSession(
  db: Db,
  deps: AuthDeps,
  userId: string,
  deviceId: string,
): Promise<Session> {
  const refresh = generateRefreshToken();
  const now = deps.clock.now();
  await db.query(
    `UPDATE devices SET refresh_token_hash=$2, refresh_expires_at=$3, last_seen_at=$4 WHERE id=$1`,
    [
      deviceId,
      hashToken(refresh, deps.env.TOKEN_PEPPER),
      new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      now,
    ],
  );
  return {
    access_token: signAccessToken(deps.env, userId, deviceId),
    refresh_token: refresh,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    device_id: deviceId,
  };
}

async function deviceLimitFor(db: Db, roles: string[], today: string): Promise<number> {
  const key =
    roles.includes('cashier') || roles.includes('auditor')
      ? 'max_devices_privileged'
      : 'max_devices_per_member';
  const res = await db.query(
    `SELECT value FROM rules WHERE key=$1 AND valid_from <= $2 ORDER BY valid_from DESC LIMIT 1`,
    [key, today],
  );
  const value = Number((res.rows[0] as { value: unknown } | undefined)?.value);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

// ---- activation ---------------------------------------------------------------------------

const INVALID_ACTIVATION = () =>
  new AppError(401, 'auth.invalid_activation', 'Activation code is invalid or expired');

export async function activate(
  deps: AuthDeps,
  input: Activate,
  client: ClientInfo,
): Promise<Session> {
  const now = deps.clock.now();
  const pinHash = await hashPin(input.pin, deps.env); // slow: before taking row locks

  return inTransaction(deps.pool, async (tx) => {
    const found = await tx.query(
      `SELECT u.id, u.status, u.roles FROM users u JOIN members m ON m.id = u.member_id
       WHERE m.code = $1 FOR UPDATE OF u`,
      [input.member_ref],
    );
    const user = found.rows[0] as { id: string; status: string; roles: string[] } | undefined;
    if (!user || user.status === 'disabled') throw INVALID_ACTIVATION();

    const codeRes = await tx.query(
      `SELECT id, code_hash, attempts, mode FROM activation_codes
       WHERE user_id=$1 AND consumed_at IS NULL AND expires_at > $2
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id, now],
    );
    const code = codeRes.rows[0] as
      | { id: string; code_hash: string; attempts: number; mode: 'replace' | 'add' }
      | undefined;
    if (!code) throw INVALID_ACTIVATION();
    if (code.attempts >= ACTIVATION_MAX_ATTEMPTS) {
      throw new AppError(423, 'auth.activation_locked', 'Too many attempts; ask for a new code');
    }

    if (!safeEqualHex(code.code_hash, hashToken(input.code, deps.env.TOKEN_PEPPER))) {
      // The attempt must persist even though we reject: commit it, then throw.
      await tx.query(`UPDATE activation_codes SET attempts = attempts + 1 WHERE id=$1`, [code.id]);
      await tx.query('COMMIT');
      await tx.query('BEGIN');
      throw INVALID_ACTIVATION();
    }

    await tx.query(`UPDATE activation_codes SET consumed_at=$2 WHERE id=$1`, [code.id, now]);

    if (code.mode === 'replace') {
      const revoked = await tx.query(
        `UPDATE devices SET revoked_at=$2, refresh_token_hash=NULL
         WHERE user_id=$1 AND revoked_at IS NULL RETURNING id`,
        [user.id, now],
      );
      if (revoked.rowCount) {
        await tx.query(
          `INSERT INTO device_events (user_id, kind, at, by) VALUES ($1,'reset',$2,$1)`,
          [user.id, now],
        );
      }
    } else {
      const active = await tx.query(
        `SELECT count(*)::int AS n FROM devices WHERE user_id=$1 AND revoked_at IS NULL`,
        [user.id],
      );
      const limit = await deviceLimitFor(tx, user.roles, deps.clock.todayDhaka());
      if ((active.rows[0] as { n: number }).n >= limit) {
        throw new AppError(409, 'auth.device_limit', 'Device limit reached');
      }
    }

    await tx.query(
      `UPDATE users SET pin_hash=$2, status='active', failed_attempts=0, locked_until=NULL,
              last_login_at=$3 WHERE id=$1`,
      [user.id, pinHash, now],
    );
    const device = await tx.query(
      `INSERT INTO devices (user_id, label, platform, install_id, last_seen_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [user.id, input.device.label ?? null, input.device.platform, input.device.install_id, now],
    );
    const deviceId = (device.rows[0] as { id: string }).id;
    await tx.query(
      `INSERT INTO device_events (user_id, kind, at, by) VALUES ($1,'registered',$2,$1)`,
      [user.id, now],
    );
    await audit(tx, {
      actor: user.id,
      action: 'auth.activate',
      entityType: 'user',
      entityId: user.id,
      after: { device_id: deviceId, platform: input.device.platform, mode: code.mode },
      ip: client.ip,
      deviceId,
    });
    return issueSession(tx, deps, user.id, deviceId);
  });
}

// ---- login --------------------------------------------------------------------------------

const INVALID_CREDENTIALS = () =>
  new AppError(401, 'auth.invalid_credentials', 'Member ID or PIN is incorrect');

export async function login(deps: AuthDeps, input: Login, client: ClientInfo): Promise<Session> {
  const now = deps.clock.now();
  const res = await deps.pool.query(
    `SELECT u.id, u.status, u.pin_hash, u.failed_attempts, u.locked_until,
            d.id AS device_id, d.revoked_at
     FROM members m
     JOIN users u ON u.member_id = m.id
     LEFT JOIN devices d ON d.id = $2 AND d.user_id = u.id
     WHERE m.code = $1`,
    [input.member_ref, input.device_id],
  );
  const row = res.rows[0] as
    | {
        id: string;
        status: string;
        pin_hash: string | null;
        failed_attempts: number;
        locked_until: Date | null;
        device_id: string | null;
        revoked_at: Date | null;
      }
    | undefined;

  if (!row || row.status !== 'active' || !row.pin_hash) {
    await fakePinCheck(input.pin, deps.env);
    throw INVALID_CREDENTIALS();
  }
  if (!row.device_id || row.revoked_at) {
    // The caller holds the device id of a replaced or unknown device: tell the app to show the
    // "ask the cashier for a new activation code" screen (spec 19.1).
    throw new AppError(401, 'auth.device_reset_needed', 'This device must be activated again');
  }
  if (row.locked_until && row.locked_until > now) {
    throw new AppError(423, 'auth.locked', 'Account is locked', {
      locked_until: row.locked_until.toISOString(),
    });
  }

  const ok = await verifyPin(row.pin_hash, input.pin, deps.env).catch(() => false);
  if (!ok) {
    const failures = row.failed_attempts + 1;
    if (failures >= PIN_MAX_FAILURES) {
      const until = new Date(now.getTime() + PIN_LOCK_MS);
      await deps.pool.query(`UPDATE users SET failed_attempts=0, locked_until=$2 WHERE id=$1`, [
        row.id,
        until,
      ]);
      await audit(deps.pool, {
        actor: row.id,
        action: 'auth.locked',
        entityType: 'user',
        entityId: row.id,
        ip: client.ip,
        deviceId: row.device_id,
      });
      throw new AppError(423, 'auth.locked', 'Account is locked', {
        locked_until: until.toISOString(),
      });
    }
    await deps.pool.query(`UPDATE users SET failed_attempts=$2 WHERE id=$1`, [row.id, failures]);
    throw new AppError(401, 'auth.invalid_credentials', 'Member ID or PIN is incorrect', {
      attempts_left: PIN_MAX_FAILURES - failures,
    });
  }

  return inTransaction(deps.pool, async (tx) => {
    await tx.query(
      `UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=$2 WHERE id=$1`,
      [row.id, now],
    );
    await audit(tx, {
      actor: row.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: row.id,
      ip: client.ip,
      deviceId: row.device_id,
    });
    return issueSession(tx, deps, row.id, row.device_id as string);
  });
}

// ---- refresh and logout -------------------------------------------------------------------

export async function refresh(deps: AuthDeps, input: Refresh): Promise<Session> {
  const now = deps.clock.now();
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `SELECT d.id, d.user_id, d.revoked_at, d.refresh_token_hash, d.refresh_expires_at, u.status
       FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id=$1 FOR UPDATE OF d`,
      [input.device_id],
    );
    const d = res.rows[0] as
      | {
          id: string;
          user_id: string;
          revoked_at: Date | null;
          refresh_token_hash: string | null;
          refresh_expires_at: Date | null;
          status: string;
        }
      | undefined;
    if (!d || d.revoked_at || d.status !== 'active') {
      throw new AppError(401, 'auth.device_reset_needed', 'This device must be activated again');
    }
    // Logged out: there is nothing to rotate; the user signs in with the PIN.
    if (!d.refresh_token_hash || !d.refresh_expires_at || d.refresh_expires_at <= now) {
      throw unauthorized('auth.session_expired', 'Session expired');
    }
    if (!safeEqualHex(d.refresh_token_hash, hashToken(input.refresh_token, deps.env.TOKEN_PEPPER))) {
      // A superseded or forged refresh token means the token may have been copied: revoke the device.
      await tx.query(`UPDATE devices SET revoked_at=$2, refresh_token_hash=NULL WHERE id=$1`, [
        d.id,
        now,
      ]);
      await tx.query(
        `INSERT INTO device_events (user_id, kind, at, by) VALUES ($1,'revoked',$2,NULL)`,
        [d.user_id, now],
      );
      await audit(tx, {
        actor: d.user_id,
        action: 'auth.refresh_reuse',
        entityType: 'device',
        entityId: d.id,
        deviceId: d.id,
      });
      await tx.query('COMMIT');
      await tx.query('BEGIN');
      throw new AppError(401, 'auth.refresh_reuse', 'Session revoked; sign in again');
    }
    return issueSession(tx, deps, d.user_id, d.id);
  });
}

export async function logout(deps: AuthDeps, user: AuthUser, client: ClientInfo): Promise<void> {
  await deps.pool.query(
    `UPDATE devices SET refresh_token_hash=NULL, refresh_expires_at=NULL, step_up_at=NULL WHERE id=$1`,
    [user.device_id],
  );
  await audit(deps.pool, {
    actor: user.id,
    action: 'auth.logout',
    entityType: 'device',
    entityId: user.device_id,
    ip: client.ip,
    deviceId: user.device_id,
  });
}

// ---- request authentication ---------------------------------------------------------------

export async function authenticateToken(deps: AuthDeps, token: string): Promise<AuthUser> {
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, deps.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string') throw new Error('bad token');
    claims = decoded;
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw unauthorized(expired ? 'auth.token_expired' : 'auth.unauthorized', 'Authentication required');
  }
  const userId = claims.sub;
  const deviceId = claims['did'] as unknown;
  if (typeof userId !== 'string' || typeof deviceId !== 'string') throw unauthorized();

  const res = await deps.pool.query(
    `SELECT u.id, u.member_id, m.code AS member_code, m.full_name, u.roles,
            u.status AS user_status, m.status AS member_status, u.totp_enabled,
            d.id AS device_id, d.step_up_at
     FROM users u
     JOIN members m ON m.id = u.member_id
     JOIN devices d ON d.id = $2 AND d.user_id = u.id AND d.revoked_at IS NULL
     WHERE u.id = $1`,
    [userId, deviceId],
  );
  const user = res.rows[0] as AuthUser | undefined;
  if (!user || user.user_status !== 'active') throw unauthorized();
  return user;
}

export function hasRecentStepUp(user: AuthUser, clock: Clock): boolean {
  return !!user.step_up_at && clock.now().getTime() - user.step_up_at.getTime() < STEP_UP_TTL_MS;
}

// ---- TOTP ---------------------------------------------------------------------------------

const PRIVILEGED = ['cashier', 'auditor'];
const isPrivileged = (u: AuthUser) => u.roles.some((r) => PRIVILEGED.includes(r));

export async function totpEnroll(
  deps: AuthDeps,
  user: AuthUser,
  client: ClientInfo,
): Promise<{ secret: string; otpauth_url: string }> {
  if (!isPrivileged(user)) throw forbidden();
  if (user.totp_enabled) throw conflict('auth.totp_already_enrolled', 'TOTP is already enrolled');
  const secret = authenticator.generateSecret();
  await inTransaction(deps.pool, async (tx) => {
    await tx.query(`UPDATE users SET totp_secret_enc=$2, totp_enabled=false WHERE id=$1`, [
      user.id,
      encryptSecret(secret, deps.env.APP_ENCRYPTION_KEY),
    ]);
    // The secret itself is never audited.
    await audit(tx, {
      actor: user.id,
      action: 'auth.totp_enroll_started',
      entityType: 'user',
      entityId: user.id,
      ip: client.ip,
      deviceId: user.device_id,
    });
  });
  return {
    secret,
    otpauth_url: authenticator.keyuri(user.member_code, 'Barakah Fund', secret),
  };
}

/** Confirms enrolment on first success and opens a 12 h step-up window on this device. */
export async function totpVerify(
  deps: AuthDeps,
  user: AuthUser,
  code: string,
  client: ClientInfo,
): Promise<{ step_up_until: string }> {
  if (!isPrivileged(user)) throw forbidden();
  const now = deps.clock.now();
  const res = await deps.pool.query(`SELECT totp_secret_enc FROM users WHERE id=$1`, [user.id]);
  const enc = (res.rows[0] as { totp_secret_enc: string | null } | undefined)?.totp_secret_enc;
  if (!enc) throw conflict('auth.totp_not_enrolled', 'Enrol TOTP first');

  const secret = decryptSecret(enc, deps.env.APP_ENCRYPTION_KEY);
  // otplib reads the system clock; pass the injected one through `epoch`.
  authenticator.options = { window: 1, epoch: now.getTime() };
  const ok = authenticator.check(code, secret);
  authenticator.options = { window: 1 };
  if (!ok) throw new AppError(401, 'auth.totp_invalid', 'Authenticator code is incorrect');

  await inTransaction(deps.pool, async (tx) => {
    await tx.query(`UPDATE users SET totp_enabled=true WHERE id=$1`, [user.id]);
    await tx.query(`UPDATE devices SET step_up_at=$2 WHERE id=$1`, [user.device_id, now]);
    await audit(tx, {
      actor: user.id,
      action: user.totp_enabled ? 'auth.step_up' : 'auth.totp_enrolled',
      entityType: 'user',
      entityId: user.id,
      ip: client.ip,
      deviceId: user.device_id,
    });
  });
  return { step_up_until: new Date(now.getTime() + STEP_UP_TTL_MS).toISOString() };
}

// ---- activation codes and unlock (cashier) ------------------------------------------------

export interface IssuedCode {
  code: string;
  expires_at: string;
  qr_payload: string;
}

/**
 * Create a one-time activation code for a member's user. The plain code is returned once and only
 * its hash is stored. `createdBy` equals the target for the first-cashier bootstrap CLI.
 */
export async function issueActivationCode(
  db: pg.Pool,
  deps: Pick<AuthDeps, 'env' | 'clock'>,
  memberId: string,
  mode: 'replace' | 'add',
  createdBy: string | null,
  client: ClientInfo & { deviceId?: string | null },
  fixedCode?: string,
): Promise<IssuedCode> {
  const now = deps.clock.now();
  const plain = fixedCode ?? generateActivationCode();
  const expiresAt = new Date(now.getTime() + ACTIVATION_CODE_TTL_MS);

  const member = await inTransaction(db, async (tx) => {
    const res = await tx.query(
      `SELECT u.id AS user_id, u.status, m.code FROM users u JOIN members m ON m.id = u.member_id
       WHERE m.id = $1 FOR UPDATE OF u`,
      [memberId],
    );
    const row = res.rows[0] as { user_id: string; status: string; code: string } | undefined;
    if (!row) throw notFound('member.not_found', 'Member not found');
    if (row.status === 'disabled') throw conflict('auth.user_disabled', 'User is disabled');

    // A new code invalidates every earlier one.
    await tx.query(
      `UPDATE activation_codes SET expires_at=$2 WHERE user_id=$1 AND consumed_at IS NULL AND expires_at > $2`,
      [row.user_id, now],
    );
    await tx.query(
      `INSERT INTO activation_codes (user_id, code_hash, expires_at, mode, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [row.user_id, hashToken(plain, deps.env.TOKEN_PEPPER), expiresAt, mode, createdBy ?? row.user_id],
    );
    await audit(tx, {
      actor: createdBy ?? row.user_id,
      action: 'auth.activation_code_issued',
      entityType: 'user',
      entityId: row.user_id,
      after: { member_code: row.code, mode, expires_at: expiresAt.toISOString() },
      ip: client.ip,
      deviceId: client.deviceId ?? null,
    });
    return row;
  });

  return {
    code: plain,
    expires_at: expiresAt.toISOString(),
    qr_payload: `barakah://activate?ref=${member.code}&code=${plain}`,
  };
}

export async function unlockUser(
  deps: AuthDeps,
  actor: AuthUser,
  memberId: string,
  client: ClientInfo,
): Promise<void> {
  const res = await deps.pool.query(
    `UPDATE users SET failed_attempts=0, locked_until=NULL WHERE member_id=$1 RETURNING id`,
    [memberId],
  );
  const target = res.rows[0] as { id: string } | undefined;
  if (!target) throw notFound('member.not_found', 'Member not found');
  await audit(deps.pool, {
    actor: actor.id,
    action: 'auth.unlock',
    entityType: 'user',
    entityId: target.id,
    ip: client.ip,
    deviceId: actor.device_id,
  });
}

// ---- devices ------------------------------------------------------------------------------

export async function listDevices(db: Db, userId: string, currentDeviceId: string) {
  const res = await db.query(
    `SELECT id, label, platform, created_at, last_seen_at, id = $2 AS current
     FROM devices WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at`,
    [userId, currentDeviceId],
  );
  return res.rows as Array<{
    id: string;
    label: string | null;
    platform: string;
    created_at: Date;
    last_seen_at: Date | null;
    current: boolean;
  }>;
}

export async function revokeOwnDevice(
  deps: AuthDeps,
  user: AuthUser,
  deviceId: string,
  client: ClientInfo,
): Promise<void> {
  const now = deps.clock.now();
  await inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `UPDATE devices SET revoked_at=$3, refresh_token_hash=NULL
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
      [deviceId, user.id, now],
    );
    if (!res.rowCount) throw notFound('device.not_found', 'Device not found');
    await tx.query(
      `INSERT INTO device_events (user_id, kind, at, by) VALUES ($1,'revoked',$2,$1)`,
      [user.id, now],
    );
    await audit(tx, {
      actor: user.id,
      action: 'auth.device_revoked',
      entityType: 'device',
      entityId: deviceId,
      ip: client.ip,
      deviceId: user.device_id,
    });
  });
}

/** Security feed visible to every member (spec 19.1): who registered, revoked or reset a device. */
export async function listDeviceEvents(db: Db, limit: number) {
  const res = await db.query(
    `SELECT e.id, e.kind, e.at, m.code AS member_code, m.full_name
     FROM device_events e JOIN users u ON u.id = e.user_id JOIN members m ON m.id = u.member_id
     ORDER BY e.at DESC LIMIT $1`,
    [limit],
  );
  return res.rows as Array<{
    id: string;
    kind: string;
    at: Date;
    member_code: string;
    full_name: string;
  }>;
}
