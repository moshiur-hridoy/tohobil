import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import { AppError, badRequest, conflict } from './errors';

/**
 * Idempotency for create endpoints (spec 4): a client that retries a request with the same
 * `Idempotency-Key` gets the original response back instead of creating a second payment, file or
 * objection. This matters on the flaky mobile connections the members use.
 *
 * How it works, per `(user, key)` row in `idempotency_keys`:
 *  1. CLAIM  - insert a placeholder (`status_code = 0`). Only one request can win the insert, so two
 *              simultaneous retries never both run the handler.
 *  2. RUN    - execute the handler.
 *  3. STORE  - save the 2xx response. A failed handler deletes the placeholder so the client can retry.
 * A later request with the same key and the same request replays the stored response (header
 * `Idempotent-Replay: true`); the same key with a different request is `422 idempotency.key_reuse`;
 * a request that arrives while the first is still running is `409 idempotency.in_progress`.
 *
 * Keys are per user (a key can never replay another member's response), live for 24 h, and a
 * placeholder abandoned by a crash is taken over after 60 s.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
export const IDEMPOTENCY_PENDING_STALE_MS = 60_000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export interface IdempotencyDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
}

export function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw badRequest(
      'idempotency.invalid_key',
      'Idempotency-Key must be 8 to 128 characters: letters, digits, and _ . : -',
    );
  }
  return raw;
}

/**
 * Run `run` at most once per `(user, Idempotency-Key)`. Without the header it just runs.
 *
 * @param fingerprint a stable string describing the request payload (e.g. the JSON body, or a hash of
 *   an uploaded file). Two requests are "the same" when method, path and fingerprint match.
 */
export async function withIdempotency<T>(
  deps: IdempotencyDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  fingerprint: string,
  run: () => Promise<IdempotentResult<T>>,
): Promise<T> {
  const key = readIdempotencyKey(request);
  if (key === null) {
    const result = await run();
    void reply.status(result.status);
    return result.body;
  }

  const path = request.url.split('?')[0] ?? '/';
  const requestHash = createHash('sha256')
    .update(`${request.method} ${path}\n${fingerprint}`)
    .digest('hex');
  const now = deps.clock.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = await deps.pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, response, status_code, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 0, $4)
       ON CONFLICT (user_id, key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, response = '{}'::jsonb, status_code = 0,
             created_at = EXCLUDED.created_at
         WHERE (idempotency_keys.status_code <> 0 AND idempotency_keys.created_at < $5)
            OR (idempotency_keys.status_code = 0 AND idempotency_keys.created_at < $6)
       RETURNING 1`,
      [
        userId,
        key,
        requestHash,
        now,
        new Date(now.getTime() - IDEMPOTENCY_TTL_MS),
        new Date(now.getTime() - IDEMPOTENCY_PENDING_STALE_MS),
      ],
    );
    if ((claim.rowCount ?? 0) > 0) return runAndStore(deps, reply, userId, key, requestHash, run);

    const existing = await deps.pool.query(
      `SELECT request_hash, response, status_code FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [userId, key],
    );
    const row = existing.rows[0] as
      { request_hash: string; response: unknown; status_code: number } | undefined;
    if (!row) continue; // the other request failed and removed its placeholder: claim again
    if (row.request_hash !== requestHash) {
      throw new AppError(
        422,
        'idempotency.key_reuse',
        'This Idempotency-Key was already used for a different request',
      );
    }
    if (row.status_code === 0) {
      throw conflict(
        'idempotency.in_progress',
        'A request with this Idempotency-Key is still being processed',
      );
    }
    void reply.status(row.status_code).header('idempotent-replay', 'true');
    return row.response as T;
  }
  throw conflict(
    'idempotency.in_progress',
    'A request with this Idempotency-Key is still being processed',
  );
}

async function runAndStore<T>(
  deps: IdempotencyDeps,
  reply: FastifyReply,
  userId: string,
  key: string,
  requestHash: string,
  run: () => Promise<IdempotentResult<T>>,
): Promise<T> {
  let result: IdempotentResult<T>;
  try {
    result = await run();
  } catch (err) {
    await deps.pool
      .query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status_code = 0`, [
        userId,
        key,
      ])
      .catch(() => undefined);
    throw err;
  }
  await deps.pool.query(
    `UPDATE idempotency_keys SET response = $3::jsonb, status_code = $4
     WHERE user_id = $1 AND key = $2 AND request_hash = $5`,
    [userId, key, JSON.stringify(result.body), result.status, requestHash],
  );
  void reply.status(result.status);
  return result.body;
}
