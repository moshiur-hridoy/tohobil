import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Shared settings of the e2e stack: its own database (`barakah_e2e`), its own ports, throwaway data.
 * Never points at anything but a local Postgres.
 */
export const E2E_DB = 'barakah_e2e';
export const API_PORT = 3100;
export const WEB_PORT = 5273;
export const BASE_URL = `http://localhost:${WEB_PORT}`;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MIGRATION_FILE = `${ROOT}db/migrations/001_initial-schema.sql`;

function envFileValue(key: string): string | undefined {
  try {
    const line = readFileSync(`${ROOT}.env`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim();
  } catch {
    return undefined;
  }
}

function withDb(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

const migrator =
  process.env.MIGRATOR_DATABASE_URL ??
  envFileValue('MIGRATOR_DATABASE_URL') ??
  'postgres://barakah_migrator:barakah_migrator@localhost:5432/barakah';

if (!['localhost', '127.0.0.1'].includes(new URL(migrator).hostname)) {
  throw new Error('The e2e stack only runs against a local database');
}

export const ADMIN_URL = withDb(migrator, 'postgres');
export const E2E_MIGRATOR_URL = withDb(migrator, E2E_DB);
export const E2E_APP_URL = withDb(migrator, E2E_DB, 'barakah_app', 'barakah_app');

/** Single-use activation codes issued by prepare.ts (8 characters of Crockford base32). */
export const CODES = {
  cashier: { ref: 'M01', code: 'E2ECASH1' },
  member: { ref: 'M02', code: 'E2EMEMB2' },
  auditor: { ref: 'M07', code: 'E2EAKDT7' },
  mobileLogin: { ref: 'M03', code: 'E2EMBN03' },
  desktopLogin: { ref: 'M04', code: 'E2EDSK04' },
} as const;

export const PIN = '483917';
