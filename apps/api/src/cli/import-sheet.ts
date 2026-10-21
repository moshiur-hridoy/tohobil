import { createPool } from '../lib/db';
import { loadEnv } from '../lib/env';
import { ImportError, readDataset } from '../import/dataset';
import { loadDataset } from '../import/load';
import { verifyImport } from '../import/verify';

/**
 * Legacy sheet import, run on the server (docs/DEPLOY-PORTAINER.md section 7). The CSVs are made on
 * the owner's computer (`pnpm import:convert`), uploaded to the server folder that is mounted at
 * /import, then loaded from the `api` container's console:
 *
 *   node dist/cli/import-sheet.js load            # dry run: does everything, writes nothing
 *   node dist/cli/import-sheet.js load --commit   # writes, once per database
 *   node dist/cli/import-sheet.js verify          # compares the database with the sheet totals
 *
 * `--dir=PATH` reads the CSVs from somewhere else (default /import).
 */
async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (command !== 'load' && command !== 'verify') {
    console.error('Usage: node dist/cli/import-sheet.js load [--commit] | verify  [--dir=/import]');
    process.exit(2);
  }
  const dir = flags.find((f) => f.startsWith('--dir='))?.slice('--dir='.length) ?? '/import';
  const commit = flags.includes('--commit');

  const env = loadEnv();
  const ds = readDataset(dir);
  const pool = createPool(env.DATABASE_URL);
  try {
    if (command === 'load') {
      const report = await loadDataset(pool, ds, { commit });
      console.log(commit ? 'COMMITTED' : 'DRY RUN (nothing was written; add --commit to write)');
      console.log(JSON.stringify(report, null, 2));
      if (commit) console.log('Next: node dist/cli/import-sheet.js verify');
      return;
    }
    const report = await verifyImport(pool, ds);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      console.error(`\nIMPORT VERIFICATION FAILED (${report.failures.length}):`);
      for (const f of report.failures) console.error(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log('\nImport verification passed.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ImportError || err instanceof Error ? err.message : err);
  process.exit(1);
});
