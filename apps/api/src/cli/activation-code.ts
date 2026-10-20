import { systemClock } from '@barakah/shared';
import { issueActivationCode } from '../auth/service';
import { createPool } from '../lib/db';
import { loadEnv } from '../lib/env';

/**
 * Server-side activation code for a member: the way the FIRST cashier gets in (the app route needs
 * a cashier with TOTP, spec 19.1) and the recovery path if the cashier's own device is lost.
 *
 *   pnpm activation-code M01 [--add] [--code=12345678]
 *
 * `--code` fixes the code for easy local testing (8 characters, Crockford base32). It is refused
 * when NODE_ENV=production or the database is not local.
 *
 * Run it on the server (`docker compose exec api node dist/cli/activation-code.js M01` in
 * production). Whoever can run it already owns the database, so the code is recorded in the audit
 * log with no actor. Print once, hand it over in person.
 */
async function main(): Promise<void> {
  const [ref, ...flags] = process.argv.slice(2);
  if (!ref || !/^M\d{2}$/i.test(ref)) {
    console.error('Usage: pnpm activation-code M01 [--add] [--code=12345678]');
    process.exit(2);
  }
  const fixed = flags.find((f) => f.startsWith('--code='))?.slice('--code='.length);
  if (fixed !== undefined && !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(fixed)) {
    console.error('--code must be 8 characters from 0-9 A-Z without I, L, O, U');
    process.exit(2);
  }
  const mode = flags.includes('--add') ? 'add' : 'replace';

  const env = loadEnv();
  if (fixed !== undefined && (env.NODE_ENV === 'production' || !/@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL))) {
    console.error('--code is only allowed against a local database outside production');
    process.exit(2);
  }
  const pool = createPool(env.DATABASE_URL);
  try {
    const res = await pool.query(`SELECT id FROM members WHERE code = $1`, [ref.toUpperCase()]);
    const member = res.rows[0] as { id: string } | undefined;
    if (!member) {
      console.error(`No member ${ref.toUpperCase()}`);
      process.exit(1);
    }
    const issued = await issueActivationCode(pool, { env, clock: systemClock }, member.id, mode, null, {}, fixed);
    console.log(`Member      ${ref.toUpperCase()}`);
    console.log(`Code        ${issued.code}`);
    console.log(`Expires     ${issued.expires_at} (single use, 5 attempts)`);
    console.log(`QR payload  ${issued.qr_payload}`);
    console.log(`Mode        ${mode === 'add' ? 'add a device' : 'replace all devices'}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
