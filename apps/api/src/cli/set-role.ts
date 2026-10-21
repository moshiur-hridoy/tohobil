import { createPool } from '../lib/db';
import { loadEnv } from '../lib/env';
import { audit } from '../lib/audit';
import { inTransaction } from '../lib/tx';

/**
 * Server-side role change: how the first cashier and auditor get their roles after the legacy
 * import, which creates every member as a plain member. Whoever can run it already owns the
 * database, so the change is audited with no actor.
 *
 *   node dist/cli/set-role.js M01 cashier     # M01 becomes the cashier (and stays a member)
 *   node dist/cli/set-role.js M07 auditor
 *   node dist/cli/set-role.js M01 member      # back to a plain member
 *
 * The database allows one active cashier and one active auditor, never the same person, so the
 * previous holder must be set back to `member` first.
 */
async function main(): Promise<void> {
  const [ref, role] = process.argv.slice(2);
  if (!ref || !/^M\d{2}$/i.test(ref) || !['cashier', 'auditor', 'member'].includes(role ?? '')) {
    console.error('Usage: node dist/cli/set-role.js M01 cashier|auditor|member');
    process.exit(2);
  }
  const roles = role === 'member' ? ['member'] : ['member', role as string];
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  try {
    const res = await pool.query(
      `SELECT u.id, u.roles FROM users u JOIN members m ON m.id = u.member_id WHERE m.code = $1`,
      [ref.toUpperCase()],
    );
    const user = res.rows[0] as { id: string; roles: string[] } | undefined;
    if (!user) {
      console.error(`No member ${ref.toUpperCase()}`);
      process.exit(1);
    }
    await inTransaction(pool, async (tx) => {
      await tx.query(`UPDATE users SET roles = $2::text[] WHERE id = $1`, [user.id, roles]);
      await audit(tx, {
        action: 'user.set_roles',
        entityType: 'user',
        entityId: user.id,
        before: { roles: user.roles },
        after: { roles },
      });
    });
    console.log(`Member ${ref.toUpperCase()} now has roles: ${roles.join(', ')}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
