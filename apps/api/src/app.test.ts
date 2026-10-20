import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { buildApp } from './app';
import { conflict } from './lib/errors';
import { parseEnv, type Env } from './lib/env';
import type { DbHandle } from './lib/db';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PUBLIC_ORIGIN: 'https://fund.example',
  APP_ENCRYPTION_KEY: 'ab'.repeat(32),
  JWT_SECRET: 'j'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(20),
  INTERNAL_ALERT_SECRET: 'a'.repeat(20),
  WEB_DIST_DIR: join(tmpdir(), 'barakah-does-not-exist'),
};

const upDb: DbHandle = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
const downDb: DbHandle = {
  query: async () => {
    throw new Error('connection refused (secret-host:5432)');
  },
};

let app: FastifyInstance | undefined;

async function make(
  opts: { env?: Partial<typeof baseEnv>; db?: DbHandle; logger?: pino.Logger } = {},
) {
  const env: Env = parseEnv({ ...baseEnv, ...opts.env });
  app = await buildApp({
    env,
    db: opts.db ?? upDb,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/v1/health', () => {
  it('reports ok with a real database check', async () => {
    const a = await make();
    const res = await a.inject('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'connected', version: '0.1.0' });
  });

  it('returns 503 degraded when the database is unreachable (it used to always say ok)', async () => {
    const a = await make({ db: downDb });
    const res = await a.inject('/api/v1/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'disconnected' });
    expect(res.body).not.toContain('secret-host'); // internal error text is never returned
  });

  it('is never rate limited (polled by healthchecks)', async () => {
    const a = await make();
    for (let i = 0; i < 130; i++) {
      const res = await a.inject('/api/v1/health');
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('error handling (RFC 7807)', () => {
  it('returns problem+json for unknown API routes, with a request id', async () => {
    const a = await make();
    const res = await a.inject('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body).toMatchObject({ status: 404, code: 'not_found', instance: '/api/v1/nope' });
    expect(body.request_id).toBe(res.headers['x-request-id']);
  });

  it('maps AppError to its status, stable code and extra members', async () => {
    const a = await make();
    a.get('/t/dup', async () => {
      throw conflict('payment.duplicate_trx', 'TrxID already submitted', {
        existing_payment_id: 'p-1',
      });
    });
    const res = await a.inject('/t/dup');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'payment.duplicate_trx',
      existing_payment_id: 'p-1',
      type: 'urn:barakah:error:payment.duplicate_trx',
    });
  });

  it('turns schema failures into 400 validation.error with a field list', async () => {
    const a = await make();
    a.withTypeProvider<ZodTypeProvider>().post(
      '/t/validate',
      { schema: { body: z.object({ amount_paisa: z.string().regex(/^\d+$/) }) } },
      async () => ({ ok: true }),
    );
    const res = await a.inject({
      method: 'POST',
      url: '/t/validate',
      payload: { amount_paisa: '5.5' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('validation.error');
    expect(body.errors[0].path).toBe('amount_paisa');
  });

  it('never leaks internals on 5xx, and the error is actually logged', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const a = await make({ logger: pino({ level: 'info' }, sink) });
    a.get('/t/boom', async () => {
      throw new Error('SELECT * FROM users WHERE pin_hash = secret');
    });
    const res = await a.inject('/t/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'internal.error', title: 'Internal Server Error' });
    expect(res.body).not.toContain('SELECT');

    // With `logger: false` (the original bug) request.log was a no-op and 5xx errors vanished.
    const entries = lines
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { level: number; msg: string });
    const errorEntry = entries.find((e) => e.msg === 'Unhandled error');
    expect(errorEntry?.level).toBe(50); // pino "error"
    expect(errorEntry).toMatchObject({ reqId: expect.any(String) });
  });
});

describe('security headers and CORS', () => {
  it('sends a strict CSP, HSTS, no-store and a request id on API responses', async () => {
    const a = await make();
    const res = await a.inject('/api/v1/health');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/style-src 'self'(;|$)/); // no 'unsafe-inline' for stylesheets
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('allows PATCH/DELETE preflight from the app and Capacitor origins only', async () => {
    const a = await make();
    for (const origin of ['https://fund.example', 'https://localhost', 'capacitor://localhost']) {
      const res = await a.inject({
        method: 'OPTIONS',
        url: '/api/v1/health',
        headers: { origin, 'access-control-request-method': 'PATCH' },
      });
      expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
      expect(String(res.headers['access-control-allow-methods'])).toContain('PATCH');
      expect(String(res.headers['access-control-allow-methods'])).toContain('DELETE');
    }
    const evil = await a.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('answers the 121st request in a minute with a 429 problem', async () => {
    const a = await make();
    a.get('/t/ping', async () => ({ ok: true }));
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await a.inject('/t/ping')).statusCode;
    expect(last).toBe(429);
    const res = await a.inject('/t/ping');
    expect(res.json()).toMatchObject({ status: 429, code: 'rate_limit.exceeded' });
  });
});

describe('rate limiting per signed-in user (spec 11)', () => {
  const token = (sub: string, secret = baseEnv.JWT_SECRET) => jwt.sign({ did: 'd' }, secret, { algorithm: 'HS256', subject: sub });
  const hit = (a: FastifyInstance, bearer?: string) =>
    a.inject({ url: '/t/ping', ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) });

  it('gives each member their own allowance even from the same address', async () => {
    const a = await make({ env: { RATE_LIMIT_PER_MINUTE: '3' } as never });
    a.get('/t/ping', async () => ({ ok: true }));
    for (let i = 0; i < 3; i++) expect((await hit(a, token('alice'))).statusCode).toBe(200);
    expect((await hit(a, token('alice'))).statusCode).toBe(429);
    // Bob, same IP, is untouched by Alice's burst
    expect((await hit(a, token('bob'))).statusCode).toBe(200);
  });

  it('cannot be dodged with a forged or invented identity: those fall back to the shared IP allowance', async () => {
    const a = await make({ env: { RATE_LIMIT_PER_MINUTE: '3' } as never });
    a.get('/t/ping', async () => ({ ok: true }));
    for (let i = 0; i < 3; i++) expect((await hit(a, token(`ghost-${i}`, 'x'.repeat(40)))).statusCode).toBe(200);
    expect((await hit(a, token('ghost-9', 'x'.repeat(40)))).statusCode).toBe(429);
    expect((await hit(a)).statusCode).toBe(429); // no token at all shares that same IP bucket
  });
});

describe('serving the built web app', () => {
  function webRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'barakah-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dir, 'sw.js'), '// service worker');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    return dir;
  }

  it('falls back to index.html for client routes, never for missing assets or API paths', async () => {
    const a = await make({ env: { WEB_DIST_DIR: webRoot() } });

    const route = await a.inject('/votes/123');
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('<title>app</title>');

    const missingAsset = await a.inject('/assets/gone-123.js');
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers['content-type']).toContain('application/problem+json');

    const api = await a.inject('/api/v1/unknown');
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/problem+json');
  });

  it('sets cache headers that avoid the "stale app until data is cleared" problem', async () => {
    const a = await make({ env: { WEB_DIST_DIR: webRoot() } });
    expect((await a.inject('/')).headers['cache-control']).toBe('no-cache');
    expect((await a.inject('/sw.js')).headers['cache-control']).toBe('no-cache');
    expect((await a.inject('/assets/app-abc123.js')).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});
