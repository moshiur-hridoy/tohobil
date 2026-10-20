import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { healthRoutes } from './routes/health';
import { createLogger } from './lib/logger';
import { errorHandler, buildProblem } from './lib/error-handler';
import { AppError } from './lib/errors';
import { parseTrustProxy, type Env } from './lib/env';
import type { DbHandle } from './lib/db';

export interface BuildAppOptions {
  env: Env;
  db: DbHandle;
  logger?: Logger;
}

/** Files that must never be served from cache, or users keep running a stale app (spec 8, PWA). */
const NO_CACHE_FILES = new Set([
  'index.html',
  'sw.js',
  'registerSW.js',
  'manifest.webmanifest',
  'offline.html',
]);

function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api' || path.startsWith('/api/');
}

export async function buildApp({ env, db, logger }: BuildAppOptions): Promise<FastifyInstance> {
  const log: FastifyBaseLogger = logger ?? createLogger(env.LOG_LEVEL);

  const app = Fastify({
    // Pass our pino instance so request.log works (with `logger: false` every request.log call,
    // including the 5xx error log, is a silent no-op).
    loggerInstance: log,
    // We log one line per request ourselves (path only, no query string), so switch off the defaults.
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    // Only the tunnel network may set X-Forwarded-*; otherwise request.ip would be the proxy for
    // everyone, breaking rate limits and the audit log's ip column.
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // ---- Security (spec 11) ------------------------------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React sets inline style attributes through the CSSOM; stylesheets themselves are files.
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  });

  const origins = [
    env.PUBLIC_ORIGIN,
    ...env.CORS_EXTRA_ORIGINS.split(',').map((o) => o.trim()),
  ].filter(Boolean);
  await app.register(cors, {
    origin: origins,
    // Bearer tokens, not cookies: no credentialed requests are needed.
    credentials: false,
    // @fastify/cors defaults to GET,HEAD,POST, which would fail the preflight for PATCH/DELETE.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    // Per-user keys and the stricter auth-route limit (10/min/IP) arrive with auth in Phase 1.
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) =>
      new AppError(429, 'rate_limit.exceeded', `Too many requests. Retry in ${context.after}.`),
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', String(request.id));
    // API responses carry personal financial data: keep them out of shared/browser HTTP caches.
    if (isApiPath(request.url)) void reply.header('cache-control', 'no-store');
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/v1/health')) return;
    request.log.info(
      {
        method: request.method,
        // Path only, never the query string.
        path: request.url.split('?')[0],
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  // ---- API routes --------------------------------------------------------------------------
  await app.register(healthRoutes(db, env.APP_VERSION), { prefix: '/api/v1' });

  // ---- Web app (the API image serves the built SPA at /, spec 12) ---------------------------
  const webRoot = resolve(env.WEB_DIST_DIR);
  const serveWeb = existsSync(resolve(webRoot, 'index.html'));

  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      // Otherwise the plugin stamps its own `public, max-age=0` and our per-file policy below is lost.
      cacheControl: false,
      // @fastify/static >= 9 passes the Fastify reply (not the raw response) to setHeaders.
      setHeaders: (reply, filePath) => {
        const name = filePath.split(/[\\/]/).pop() ?? '';
        if (NO_CACHE_FILES.has(name)) {
          void reply.header('cache-control', 'no-cache');
        } else if (/[\\/]assets[\\/]/.test(filePath)) {
          void reply.header('cache-control', 'public, max-age=31536000, immutable'); // content-hashed
        } else {
          void reply.header('cache-control', 'public, max-age=3600');
        }
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const isNavigation =
      (request.method === 'GET' || request.method === 'HEAD') && !/\.[A-Za-z0-9]+$/.test(path);

    // SPA fallback for client-side routes only. A missing asset (…/chunk.js) must stay a 404:
    // answering with index.html would make the browser fail with a baffling syntax error.
    if (serveWeb && !isApiPath(request.url) && isNavigation) {
      return reply.sendFile('index.html');
    }
    return reply
      .status(404)
      .header('content-type', 'application/problem+json')
      .send(buildProblem(request, 404, 'not_found', 'Not found'));
  });

  return app;
}
