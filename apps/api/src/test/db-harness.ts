import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Real-Postgres test harness (spec 14: integration tests run against real Postgres, never a mock).
 *
 * Server selection:
 *   1. TEST_DATABASE_URL  - a superuser connection to any Postgres server; each test file gets its own
 *      freshly created database on it, dropped afterwards.
 *   2. otherwise Testcontainers starts postgres:16-alpine (needs a running Docker daemon).
 *   3. if neither is available, createTestDb() returns null and the DB tests skip with a warning,
 *      unless CI or REQUIRE_DB_TESTS=1 is set: then it throws, so a pipeline can never go green
 *      while silently skipping the ledger and money tests.
 */

const MIGRATION_FILE = fileURLToPath(
  new URL('../../../../db/migrations/001_initial-schema.sql', import.meta.url),
);

export interface TestDb {
  /** Superuser/owner pool: used to arrange data and to attempt tampering. */
  admin: pg.Pool;
  /** Pool connected as the unprivileged application role (barakah_app). */
  app: pg.Pool;
  /** Pool connected as the verifier role (barakah_readonly). */
  readonly: pg.Pool;
  close(): Promise<void>;
}

interface Server {
  adminUrl: string;
  stop?: () => Promise<void>;
}

let serverPromise: Promise<Server | null> | undefined;

async function startServer(): Promise<Server | null> {
  if (process.env.TEST_DATABASE_URL) return { adminUrl: process.env.TEST_DATABASE_URL };
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    return {
      adminUrl: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const message = `[db tests] No database available (set TEST_DATABASE_URL or start Docker): ${(err as Error).message}`;
    if (process.env.CI || process.env.REQUIRE_DB_TESTS === '1') throw new Error(message);
    console.warn(message);
    return null;
  }
}

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** The "Up Migration" part of the SQL migration (the Down part is intentionally a hard stop). */
export function upMigrationSql(): string {
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  return sql.split(/^-- Down Migration/m)[0] as string;
}

export async function createTestDb(): Promise<TestDb | null> {
  serverPromise ??= startServer();
  const server = await serverPromise;
  if (!server) return null;

  const dbName = `barakah_test_${randomBytes(4).toString('hex')}`;
  const root = new pg.Client({ connectionString: server.adminUrl });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${dbName}`);
    // Roles are cluster-wide; create them idempotently so parallel test files don't race.
    for (const role of ['barakah_app', 'barakah_readonly']) {
      await root.query(
        `DO $$
         BEGIN
           CREATE ROLE ${role} LOGIN PASSWORD '${role}';
         EXCEPTION WHEN duplicate_object THEN
           NULL;
         END
         $$`,
      );
    }
  } finally {
    await root.end();
  }

  const adminUrl = withDatabase(server.adminUrl, dbName);
  const admin = new pg.Pool({ connectionString: adminUrl, max: 25 });
  await admin.query(upMigrationSql());

  const app = new pg.Pool({
    connectionString: withDatabase(server.adminUrl, dbName, 'barakah_app', 'barakah_app'),
    max: 5,
  });
  const readonly = new pg.Pool({
    connectionString: withDatabase(server.adminUrl, dbName, 'barakah_readonly', 'barakah_readonly'),
    max: 2,
  });

  return {
    admin,
    app,
    readonly,
    async close() {
      await app.end();
      await readonly.end();
      await admin.end();
      // Give sockets a moment to close before the server forcibly terminates them.
      await new Promise((r) => setTimeout(r, 200));
      const cleanup = new pg.Client({ connectionString: server.adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
