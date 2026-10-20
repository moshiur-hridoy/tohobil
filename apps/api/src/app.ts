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
import { createLogger } from './lib/logger';
import { healthRoutes } from './routes/health';
import { errorHandler, buildProblem } from './lib/error-handler';
import { AppError } from './lib/errors';
import { parseTrustProxy, type Env } from './lib/env';
import { systemClock, type Clock } from '@barakah/shared';
import type pg from 'pg';
import type { DbHandle } from './lib/db';
import { authRoutes } from './routes/auth';
import { memberRoutes } from './routes/members';
import { referenceRoutes } from './routes/reference';
import { fileRoutes } from './routes/files';
import { ledgerRoutes } from './routes/ledger';
import { paymentRoutes } from './routes/payments';
import { matrixRoutes } from './routes/matrix';
import { objectionRoutes } from './routes/objections';
import { notificationRoutes } from './routes/notifications';
import { assetRoutes } from './routes/assets';
import { rentRoutes } from './routes/rent';
import { navRoutes } from './routes/nav';
import { obligationRoutes } from './routes/obligations';
import { periodRoutes } from './routes/periods';
import { reportRoutes } from './routes/reports';
import { systemRoutes } from './routes/system';
import { proposalRoutes } from './routes/proposals';
import { settingsRoutes } from './routes/settings';
import { charityRoutes } from './routes/charity';
import { constitutionRoutes } from './routes/constitution';
import { FileStore } from './files/storage';
import { createGuards } from './auth/guards';
import { createSmsProvider } from './notifications/providers/sms';
import { ConsolePushSender, FcmPushSender } from './notifications/providers/push';
import type { PushSender } from './notifications/providers/push';
import type { SmsProvider } from './notifications/providers/sms';

  export interface BuildAppOptions {
  env: Env;
  db: DbHandle;
  logger?: Logger;
  clock?: Clock;
  pushSender?: PushSender;
  smsProvider?: SmsProvider;
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

export async function buildApp({
  env,
  db,
  logger,
  clock = systemClock,
  pushSender: pushSenderOpt,
  smsProvider: smsProviderOpt,
}: BuildAppOptions): Promise<FastifyInstance> {
  const log: FastifyBaseLogger = logger ?? createLogger(env.LOG_LEVEL);

  const appVersionDefaults = {
    min: env.APP_MIN_VERSION,
    latest: env.APP_LATEST_VERSION,
    download_url: env.APK_DOWNLOAD_URL,
  };

  const fcmFile = env.FCM_SERVICE_ACCOUNT_JSON_PATH;
  const pushSender =
    pushSenderOpt ??
    (fcmFile && existsSync(fcmFile) ? new FcmPushSender() : new ConsolePushSender(log as unknown as Logger));
  const smsProvider =
    smsProviderOpt ??
    createSmsProvider(
      {
        provider: env.SMS_PROVIDER,
        httpUrl: env.SMS_HTTP_URL,
        apiKey: env.SMS_HTTP_API_KEY,
        senderId: env.SMS_SENDER_ID,
        bodyTemplate: env.SMS_HTTP_BODY_TEMPLATE,
      },
      log as unknown as Logger,
    );

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
    max: env.RATE_LIMIT_PER_MINUTE,
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

  // Routes that need transactions require a real pool; the health tests pass a bare fake.
  if (typeof (db as Partial<pg.Pool>).connect === 'function') {
    const deps = { pool: db as pg.Pool, env, clock };
    const guards = createGuards(deps);
    await app.register(authRoutes(deps, guards), { prefix: '/api/v1' });
    await app.register(
      memberRoutes(
        { pool: deps.pool, clock: deps.clock, pushSender, smsProvider, log: log as unknown as Logger },
        guards,
      ),
      { prefix: '/api/v1' },
    );
    await app.register(referenceRoutes(deps, guards), { prefix: '/api/v1' });
    await app.register(settingsRoutes({ pool: deps.pool }, guards), { prefix: '/api/v1' });
    await app.register(ledgerRoutes(deps, guards), { prefix: '/api/v1' });
    await app.register(
      paymentRoutes({ ...deps, log: log as unknown as Logger, pushSender, smsProvider }, guards),
      { prefix: '/api/v1' },
    );
    await app.register(matrixRoutes(deps, guards), { prefix: '/api/v1' });
    await app.register(objectionRoutes(deps, guards), { prefix: '/api/v1' });
    await app.register(
      notificationRoutes(
        { pool: deps.pool, clock: deps.clock, appVersionDefaults, pushSender, smsProvider },
        guards,
      ),
      { prefix: '/api/v1' },
    );
    await app.register(assetRoutes({ pool: deps.pool, clock: deps.clock }, guards), { prefix: '/api/v1' });
    await app.register(rentRoutes({ pool: deps.pool, clock: deps.clock }, guards), { prefix: '/api/v1' });
    await app.register(navRoutes({ pool: deps.pool, clock: deps.clock }, guards), { prefix: '/api/v1' });
    await app.register(obligationRoutes({ pool: deps.pool, clock: deps.clock }, guards), { prefix: '/api/v1' });
    const archiveStore = new FileStore(env.FILES_DIR);
    await app.register(
      periodRoutes({ pool: deps.pool, clock: deps.clock, archivesDir: env.ARCHIVES_DIR, files: archiveStore }, guards),
      { prefix: '/api/v1' },
    );
    await app.register(reportRoutes({ pool: deps.pool, clock: deps.clock, archivesDir: env.ARCHIVES_DIR }, guards), { prefix: '/api/v1' });
    await app.register(
      systemRoutes(
        { pool: deps.pool, clock: deps.clock, statusDir: env.STATUS_DIR, filesDir: env.FILES_DIR, alertSecret: env.INTERNAL_ALERT_SECRET },
        guards,
      ),
      { prefix: '/api/v1' },
    );
    await app.register(proposalRoutes({ pool: deps.pool, clock: deps.clock }, guards), { prefix: '/api/v1' });
    await app.register(charityRoutes({ pool: deps.pool, clock: deps.clock }, guards), { prefix: '/api/v1' });
    await app.register(
      constitutionRoutes({ pool: deps.pool, clock: deps.clock }, guards),
      { prefix: '/api/v1' },
    );
    await app.register(
      fileRoutes(
        {
          ...deps,
          store: new FileStore(env.FILES_DIR),
          uploadsPerMinute: env.UPLOAD_RATE_LIMIT_PER_MINUTE,
        },
        guards,
      ),
      { prefix: '/api/v1' },
    );
  }

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
