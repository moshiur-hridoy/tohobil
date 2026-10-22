/**
 * Stage 2: normalized CSVs -> database, through the API's posting service. DRY RUN BY DEFAULT.
 *
 *   pnpm import:load [--dir DIR] [--commit] [--allow-remote]
 *
 * One transaction: a dry run does everything and rolls back, so its report is what --commit writes.
 * Refuses a non-local database (and NODE_ENV=production) unless --allow-remote is given.
 */
import pg from 'pg';
import { ImportError, readDataset } from '../../apps/api/src/import/dataset';
import { assertSafeTarget, loadDataset } from '../../apps/api/src/import/load';
import { DEFAULT_NORMALIZED, pathFlag, loadEnv } from './common';

loadEnv();
const argv = process.argv.slice(2);
const commit = argv.includes('--commit');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new ImportError('DATABASE_URL is not set');
  assertSafeTarget(url, process.env.NODE_ENV, argv.includes('--allow-remote'));
  const ds = readDataset(pathFlag(argv, 'dir') ?? DEFAULT_NORMALIZED);

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const report = await loadDataset(pool, ds, { commit });
    console.log(commit ? 'COMMITTED' : 'DRY RUN (nothing was written; add --commit to write)');
    console.log(JSON.stringify(report, null, 2));
    if (commit) console.log('Next: pnpm import:verify && pnpm verify-ledger');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
