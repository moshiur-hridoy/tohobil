import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration, validated once at startup so a mis-configured deployment fails fast
 * with a readable message instead of misbehaving later. Error messages name the variable and the
 * rule, never the value (values may be secrets).
 */

const MIN_SECRET_LENGTH = 32;

/** Example/placeholder secrets shipped in .env.example. They must never run in production. */
const PLACEHOLDER = /change[-_ ]?me|dev-only/i;
const DEV_ENCRYPTION_KEY = '0'.repeat(64);

const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    PUBLIC_ORIGIN: z.string().url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_VERSION: z.string().default('0.1.0'),

    /** Fastify trustProxy: 'false', 'true', or a comma-separated list of IPs/CIDRs (the tunnel network). */
    TRUST_PROXY: z.string().default('false'),
    /** Extra browser origins allowed by CORS (the Capacitor WebView origins by default). */
    CORS_EXTRA_ORIGINS: z.string().default('https://localhost,capacitor://localhost'),
    /** Directory holding the built web app; served at / when it exists. */
    WEB_DIST_DIR: z.string().default('public'),
    /**
     * Where uploaded files live, content-addressed by sha256 (spec 2, 11). Never under a static path.
     * Production mounts the `files` volume here (/data/files); the dev default is a git-ignored folder.
     */
    FILES_DIR: z.string().min(1).default('data/files'),

    // Secrets (spec 11). Real use arrives in Phase 1; validating them now catches bad deployments early.
    APP_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes written as 64 hex characters'),
    JWT_SECRET: secret(MIN_SECRET_LENGTH),
    TOKEN_PEPPER: secret(16),
    INTERNAL_ALERT_SECRET: secret(16),

    /** Per-IP limit on login/activation/refresh/TOTP routes (brute-force guard on top of the PIN lockout). */
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    /** Per-IP limit on every other route. */
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    /** Per-IP limit on `POST /files` (each upload is re-encoded, which costs CPU and memory). */
    UPLOAD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),

    SMS_PROVIDER: z.enum(['console', 'http']).default('console'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const secrets = ['JWT_SECRET', 'TOKEN_PEPPER', 'INTERNAL_ALERT_SECRET'] as const;
    for (const key of secrets) {
      if (PLACEHOLDER.test(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'is still a placeholder value' });
      }
    }
    if (env.APP_ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENCRYPTION_KEY'],
        message: 'is the development key',
      });
    }
    if (!env.PUBLIC_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_ORIGIN'],
        message: 'must be https in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

/** Pure: validate an environment object. Used directly by tests. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  return result.data;
}

/**
 * Load `.env` (from the working directory, or the repo root when run from apps/api) without
 * overriding variables that are already set, then validate.
 */
export function loadEnv(): Env {
  for (const candidate of [resolve('.env'), resolve('..', '..', '.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
  }
  return parseEnv(process.env);
}

/** Maps TRUST_PROXY to Fastify's trustProxy option. */
export function parseTrustProxy(value: string): boolean | string[] {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
