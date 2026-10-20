/* eslint-disable no-console -- a command-line tool: stdout is its interface */
import { formatBDT, systemClock, currentPeriod } from '@barakah/shared';
import { generateDues, type GeneratedDueKind } from '../dues/service';
import { createPool } from '../lib/db';
import { loadEnv } from '../lib/env';

/**
 * Generate the dues of a period by hand (spec 5.3: "also exposed as a function so the importer and
 * tests can backfill any period"). Until the Phase 2 scheduler exists this is how a period's dues are
 * created; afterwards it is the backfill and repair tool. Idempotent: re-running creates nothing new.
 *
 *   pnpm dues:generate                 # the current Asia/Dhaka period
 *   pnpm dues:generate 2026-11         # a specific (past or current) period
 *   pnpm dues:generate 2026-01 --start-boost   # also the one-time legacy start-boost due
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const period = args.find((a) => !a.startsWith('--')) ?? currentPeriod(systemClock);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    console.error('Usage: pnpm dues:generate [YYYY-MM] [--start-boost]');
    process.exit(2);
  }
  const kinds: GeneratedDueKind[] = flags.includes('--start-boost')
    ? ['monthly', 'start_boost']
    : ['monthly'];

  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  try {
    const result = await generateDues({ pool, clock: systemClock }, { period, kinds });
    if (result.skipped) {
      console.log(`Period ${period}: nothing generated (${result.skipped.replace(/_/g, ' ')}).`);
      return;
    }
    console.log(
      `Period ${period}: ${result.created.length} created, ${result.already_existed} already existed.`,
    );
    for (const d of result.created) {
      console.log(
        `  ${d.member_code}  ${d.kind.padEnd(11)} ${d.shares} share(s)  Tk ${formatBDT(d.amount_paisa, { digits: 'en' })}  due ${d.due_date}`,
      );
    }
    if (result.credit_applied_paisa > 0n) {
      console.log(
        `Applied Tk ${formatBDT(result.credit_applied_paisa, { digits: 'en' })} of unallocated member credit.`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
