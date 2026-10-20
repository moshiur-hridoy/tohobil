/**
 * One-shot migration runner: the `migrate` compose service runs `node dist/migrate.js` before the
 * API starts (spec 12), and `pnpm migrate` runs it in development. Applies pending migrations from
 * db/migrations using MIGRATOR_DATABASE_URL (the owning role), never the app role.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import PgBoss from 'pg-boss';
import { JOB_QUEUES } from './jobs/queues';
import { createLogger } from './lib/logger';

try {
  for (const candidate of [resolve('.env'), resolve('..', '..', '.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
  }
} catch {
  // Fall back to the process environment.
}

const logger = createLogger();

function findMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    resolve(here, '..', 'db', 'migrations'), // container: /app/dist -> /app/db/migrations
    resolve(here, '..', '..', '..', 'db', 'migrations'), // repo: apps/api/src -> db/migrations
  ].filter((c): c is string => !!c);
  const found = candidates.find((c) => existsSync(c));
  if (!found)
    throw new Error(`Migrations directory not found (looked in: ${candidates.join(', ')})`);
  return found;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATOR_DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATOR_DATABASE_URL is not set');

  const dir = findMigrationsDir();
  const applied = await runner({
    databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    log: (msg) => logger.info(msg),
  });
  logger.info({ dir, applied: applied.map((m) => m.name) }, 'Migrations complete');

  // pg-boss installs its own tables on first start with `CREATE SCHEMA IF NOT EXISTS`, which the
  // unprivileged app role may not run, so install them (and the queues, which attach partitions to a table the app role does not own) here as the owning role. Idempotent; the
  // default privileges in the baseline migration give the app role access to what this creates.
  const boss = new PgBoss({ connectionString: databaseUrl, max: 1, supervise: false, schedule: false });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss install error'));
  await boss.start();
  for (const name of JOB_QUEUES) await boss.createQueue(name, { name, policy: 'singleton' });
  await boss.stop({ graceful: false });
  logger.info('pg-boss schema and queues ready');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
