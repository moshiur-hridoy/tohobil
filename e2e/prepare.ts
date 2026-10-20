import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { ADMIN_URL, CODES, E2E_APP_URL, E2E_DB, E2E_MIGRATOR_URL, MIGRATION_FILE } from './env';

/**
 * Build a fresh e2e database: drop and create `barakah_e2e`, apply the schema, load the fictional
 * fixture, generate this month's dues and issue the single-use activation codes the tests use.
 * Run by `pnpm e2e` before Playwright starts the API and the web app.
 */
async function main(): Promise<void> {
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  try {
    await root.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${E2E_DB}`);
    await root.query(`ALTER DATABASE ${E2E_DB} OWNER TO barakah_app`);
    await root.query(`GRANT ALL PRIVILEGES ON DATABASE ${E2E_DB} TO barakah_migrator`);
  } finally {
    await root.end();
  }

  const db = new pg.Client({ connectionString: E2E_MIGRATOR_URL });
  await db.connect();
  try {
    await db.query((readFileSync(MIGRATION_FILE, 'utf8').split(/^-- Down Migration/m)[0]) as string);
  } finally {
    await db.end();
  }

  const env = { ...process.env, MIGRATOR_DATABASE_URL: E2E_MIGRATOR_URL, DATABASE_URL: E2E_APP_URL };
  if (env.SMS_HTTP_URL === '') delete env.SMS_HTTP_URL;
  const run = (args: string[]) => execFileSync('pnpm', args, { env, stdio: 'inherit' });
  run(['exec', 'tsx', 'db/seed/run.ts']);
  run(['--filter', '@barakah/api', 'exec', 'tsx', 'src/cli/generate-dues.ts']);
  for (const { ref, code } of Object.values(CODES)) {
    run(['--filter', '@barakah/api', 'exec', 'tsx', 'src/cli/activation-code.ts', ref, `--code=${code}`]);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
