/**
 * Seed the database with fictional data for development and testing (spec 14.2).
 * 8 members with shares [2,4,1,1,3,1,4,4], fake phones, one cashier, one auditor (different members),
 * deterministic UUIDs. Never include real names or numbers.
 *
 * Safe to run repeatedly: every row has a deterministic key and conflicts are ignored.
 * Refuses to run against anything that looks like production (spec 0.8).
 */

import pg from 'pg';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

const MIGRATOR_URL =
  process.env.MIGRATOR_DATABASE_URL ??
  'postgres://barakah_migrator:barakah_migrator@localhost:5432/barakah';

function assertNotProduction(): void {
  const host = new URL(MIGRATOR_URL).hostname;
  const isLocal = ['localhost', '127.0.0.1', '::1', 'db'].includes(host);
  if (
    process.env.NODE_ENV === 'production' ||
    (!isLocal && process.env.SEED_ALLOW_REMOTE !== '1')
  ) {
    throw new Error(
      `Refusing to seed ${host}: the seed fixture is for local development only. ` +
        'Set SEED_ALLOW_REMOTE=1 for a throwaway staging database.',
    );
  }
}

const uuid = (prefix: string, n: number): string =>
  `${prefix}0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// Cashier and auditor are different members (5.1). Users start as pending_activation (19.1): they
// receive an activation code in person; the seed never sets a PIN.
const MEMBERS = [
  { code: 'M01', name: 'সদস্য এক', phone: '+8801700000001', shares: 2, roles: '{member,cashier}' },
  { code: 'M02', name: 'সদস্য দুই', phone: '+8801700000002', shares: 4, roles: '{member}' },
  { code: 'M03', name: 'সদস্য তিন', phone: '+8801700000003', shares: 1, roles: '{member}' },
  { code: 'M04', name: 'সদস্য চার', phone: '+8801700000004', shares: 1, roles: '{member}' },
  { code: 'M05', name: 'সদস্য পাঁচ', phone: '+8801700000005', shares: 3, roles: '{member}' },
  { code: 'M06', name: 'সদস্য ছয়', phone: '+8801700000006', shares: 1, roles: '{member}' },
  { code: 'M07', name: 'সদস্য সাত', phone: '+8801700000007', shares: 4, roles: '{member,auditor}' },
  { code: 'M08', name: 'সদস্য আট', phone: '+8801700000008', shares: 4, roles: '{member}' },
] as const;

async function seed(): Promise<void> {
  assertNotProduction();

  const client = new pg.Client({ connectionString: MIGRATOR_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    let shareNo = 1;
    for (const [i, m] of MEMBERS.entries()) {
      const memberId = uuid('a', i + 1);
      await client.query(
        `INSERT INTO members (id, code, full_name, phone, status, joined_on)
         VALUES ($1, $2, $3, $4, 'active', '2026-01-01')
         ON CONFLICT (id) DO NOTHING`,
        [memberId, m.code, m.name, m.phone],
      );

      await client.query(
        `INSERT INTO users (id, member_id, roles, status)
         VALUES ($1, $2, $3, 'pending_activation')
         ON CONFLICT (id) DO NOTHING`,
        [uuid('b', i + 1), memberId, m.roles],
      );

      await client.query(
        `INSERT INTO share_holdings (id, member_id, shares, effective_from, source)
         VALUES ($1, $2, $3, '2026-01-01', 'initial')
         ON CONFLICT (id) DO NOTHING`,
        [uuid('c', i + 1), memberId, m.shares],
      );

      // One register row per share, grouped to owners in sheet order.
      for (let j = 0; j < m.shares; j++) {
        await client.query(
          `INSERT INTO share_register (share_no, member_id, registered_name, nominee_name, nominee_relation)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (share_no) DO NOTHING`,
          [shareNo, memberId, `শেয়ার ${shareNo}`, `নমিনি ${shareNo}`, 'পুত্র'],
        );
        shareNo++;
      }
    }

    for (let month = 1; month <= 12; month++) {
      const period = `2026-${String(month).padStart(2, '0')}`;
      await client.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [
        period,
      ]);
    }

    await client.query('COMMIT');
    console.log(`Seed completed: ${MEMBERS.length} members, ${shareNo - 1} shares`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
