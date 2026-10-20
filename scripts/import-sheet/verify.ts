/**
 * `pnpm import:verify [--dir DIR]`: checks the loaded database against expected_totals.csv and
 * opening_balances.csv (Doc.md 13). Read-only. Exit code 1 when anything differs.
 */
import pg from 'pg';
import { ImportError, readDataset } from '../../apps/api/src/import/dataset';
import { verifyImport } from '../../apps/api/src/import/verify';
import { DEFAULT_NORMALIZED, flagValue, loadEnv } from './common';

loadEnv();
const argv = process.argv.slice(2);

async function main(): Promise<void> {
  const url = process.env.READONLY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new ImportError('READONLY_DATABASE_URL or DATABASE_URL is not set');
  const ds = readDataset(flagValue(argv, 'dir') ?? DEFAULT_NORMALIZED);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
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
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
