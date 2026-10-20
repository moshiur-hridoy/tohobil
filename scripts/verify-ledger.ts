/**
 * Verify the ledger hash chain.
 *
 * Recomputes the chain in TypeScript (the same module the API uses for GET /ledger/verify and the
 * nightly job) and compares it with what the database stored. Exits 1 if anything differs.
 *
 * Uses the read-only role when READONLY_DATABASE_URL is set, otherwise DATABASE_URL.
 */

import pg from 'pg';
import { verifyLedgerChainFromDb } from '../apps/api/src/lib/ledger-chain';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

const connectionString =
  process.env.READONLY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://barakah_readonly:barakah_readonly@localhost:5432/barakah';

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await verifyLedgerChainFromDb(client);
    console.log(
      JSON.stringify({
        ok: result.ok,
        count: result.count,
        lastSeq: result.lastSeq,
        lastHash: result.lastHash,
      }),
    );
    if (!result.ok) {
      for (const issue of result.issues) {
        console.error(
          `seq ${issue.seq}: ${issue.kind} mismatch. expected ${issue.expected}, got ${issue.actual}`,
        );
      }
      console.error(
        `Ledger chain BROKEN: ${result.issues.length} issue(s) in ${result.count} entries`,
      );
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
