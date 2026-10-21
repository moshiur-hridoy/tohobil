/* eslint-disable no-console -- a command-line tool: stdout is its interface */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConstitution } from '../constitution/parse';
import { seedConstitutionVersion } from '../constitution/service';
import { createPool } from '../lib/db';
import { loadEnv } from '../lib/env';
import { inTransaction } from '../lib/tx';

/**
 * Load the group's constitution as version 1 (spec 18: seeded from the private file at deploy time),
 * clause by clause so members can search it and rules can link to their clause. Shows what it would
 * load unless --commit is given. Only for the first version: later versions are constitution_amendment
 * proposals, and a loaded version can never be deleted.
 *
 *   pnpm constitution:load                                   # dry run of private/constitution_v1.bn.md
 *   pnpm constitution:load --commit                          # load it
 *   pnpm constitution:load other.md --effective=2026-01-01 --commit
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const commit = args.includes('--commit');
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), args.find((a) => !a.startsWith('--')) ?? 'private/constitution_v1.bn.md');
  const effective = flag('effective') ?? '2026-01-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) {
    console.error('Usage: pnpm constitution:load [file] [--effective=YYYY-MM-DD] [--commit]');
    process.exit(2);
  }

  const { title, clauses, ignored } = parseConstitution(readFileSync(file, 'utf8'));
  if (clauses.length === 0) throw new Error(`No "### <number> <title>" clauses found in ${file}`);
  console.log(`${title ?? file}`);
  console.log(`${clauses.length} clauses, effective ${effective}:`);
  for (const c of clauses) console.log(`  ${c.clause_no.padEnd(5)} ${c.title}`);
  if (ignored.length > 0) console.log(`Not loaded (outside a numbered clause): ${ignored.length} line(s), e.g. "${ignored[0]}"`);

  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  try {
    const existing = await pool.query(`SELECT version FROM constitution_versions ORDER BY created_at`);
    if ((existing.rowCount ?? 0) > 0) {
      const versions = (existing.rows as Array<{ version: string }>).map((r) => r.version).join(', ');
      throw new Error(`A constitution is already loaded (version ${versions}). Change it with a constitution_amendment proposal.`);
    }
    if (!commit) {
      console.log('\nDry run: nothing written. Add --commit to load it. A loaded version cannot be deleted.');
      return;
    }
    const { version_id } = await inTransaction(pool, (tx) =>
      seedConstitutionVersion(tx, '1', null, effective, title, null, clauses),
    );
    console.log(`\nLoaded as version 1 (${version_id}). Members can now read it in the app.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
