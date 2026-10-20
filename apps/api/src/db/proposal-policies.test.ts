import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROPOSAL_TYPES } from '@barakah/shared';
import { rulePaisa } from '../lib/rules';
import { createTestDb, type TestDb } from '../test/db-harness';

/**
 * Spec 18.3 voting-policy table, written out independently of the migration so a wrong seed fails here.
 * Phase 1 only seeds and checks the schema; voting itself arrives in Phase 3.
 *   [type, basis, threshold_kind, clause_ref, requires_feasibility]
 */
const EXPECTED: ReadonlyArray<
  readonly [string, 'member' | 'share', 'majority' | 'unanimous', string | null, boolean]
> = [
  ['general', 'member', 'majority', '4.1', false],
  ['role_change', 'member', 'majority', '4.1', false],
  ['rule_change', 'member', 'majority', '4.1', false],
  ['reinstatement', 'member', 'majority', '4.1', false],
  ['fine_waiver', 'member', 'majority', '4.1', false],
  ['charity_donation', 'member', 'majority', '4.1', false],
  ['expense', 'member', 'majority', '4.1', false], // member basis below the threshold, share basis at or above
  ['member_qard', 'member', 'majority', '6.3', false],
  ['settlement', 'member', 'majority', '5.1', false],
  ['suspension', 'member', 'majority', '2.4', false],
  ['member_deceased', 'member', 'majority', '8', false],
  ['asset_cost_levy', 'member', 'majority', '6.2', false],
  ['investment_purchase', 'share', 'majority', '4.2', true],
  ['asset_sale', 'share', 'majority', '4.2', false],
  ['distribution', 'share', 'majority', '4.2', false],
  ['valuation_update', 'share', 'majority', '4.2', false],
  ['financing_arrangement', 'share', 'majority', '6.3', false],
  ['dissolution', 'share', 'majority', '10.2', false],
  ['wind_up', 'share', 'majority', '10.2', false],
  ['land_selection', 'share', 'majority', '4.2', false],
  ['project_closure', 'share', 'majority', '4.2', false],
  ['new_member', 'member', 'unanimous', '5.3', false],
  ['contribution_change', 'member', 'unanimous', '1.4', false],
  ['constitution_amendment', 'member', 'unanimous', null, false], // no clause: OWNER DECISION 5
];

let db: TestDb | null;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

function dbIt(name: string, fn: (db: TestDb) => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn(db);
  });
}

describe('proposal_policies seed and schema (spec 18.3, 18.8)', () => {
  dbIt('the table above covers every proposal type exactly once', async () => {
    expect(EXPECTED.map((e) => e[0]).sort()).toEqual([...PROPOSAL_TYPES].sort());
  });

  dbIt(
    'every policy has the basis, threshold, clause and feasibility flag the spec gives',
    async ({ app }) => {
      const res = await app.query(
        `SELECT type, basis, threshold_kind, clause_ref, requires_feasibility FROM proposal_policies ORDER BY type`,
      );
      const actual = (res.rows as Array<Record<string, unknown>>).map((r) => [
        r['type'],
        r['basis'],
        r['threshold_kind'],
        r['clause_ref'],
        r['requires_feasibility'],
      ]);
      expect(actual).toEqual(
        [...EXPECTED].sort((a, b) => a[0].localeCompare(b[0])).map((e) => [...e]),
      );
    },
  );

  dbIt('only the constitution amendment lacks a clause reference', async ({ app }) => {
    const res = await app.query(`SELECT type FROM proposal_policies WHERE clause_ref IS NULL`);
    expect(res.rows).toEqual([{ type: 'constitution_amendment' }]);
  });

  dbIt(
    'only expense switches basis by amount, and at the big-financial-decision threshold',
    async ({ app }) => {
      const res = await app.query(
        `SELECT type, amount_threshold_paisa::text AS threshold FROM proposal_policies WHERE amount_threshold_paisa IS NOT NULL`,
      );
      expect(res.rows).toEqual([{ type: 'expense', threshold: '10000000' }]);
      expect(await rulePaisa(app, 'big_financial_threshold_paisa', '2026-11-05')).toBe(10_000_000n);
    },
  );

  dbIt(
    'proposals and voters carry the weight columns used by share-basis and unanimous voting',
    async ({ app }) => {
      const cols = await app.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('proposals', 'proposal_voters')`,
      );
      const has = (table: string, column: string) =>
        (cols.rows as Array<{ table_name: string; column_name: string }>).some(
          (c) => c.table_name === table && c.column_name === column,
        );
      for (const column of [
        'basis',
        'threshold_kind',
        'eligible_count',
        'eligible_weight',
        'threshold',
        'threshold_weight',
        'yes_weight',
        'no_weight',
        'abstain_weight',
      ]) {
        expect(has('proposals', column), `proposals.${column}`).toBe(true);
      }
      expect(has('proposal_voters', 'weight')).toBe(true);
    },
  );

  dbIt(
    'a proposal must use a known type, and a policy must use a known basis and threshold',
    async ({ admin }) => {
      const member = await admin.query(
        `INSERT INTO members (code, full_name, phone, joined_on) VALUES ('M01', 'Member M01', '+8801700000001', '2026-01-01') RETURNING id`,
      );
      const creator = (member.rows[0] as { id: string }).id;
      await expect(
        admin.query(
          `INSERT INTO proposals (type, title, payload, created_by) VALUES ('buy_a_boat', 'x', '{}', $1)`,
          [creator],
        ),
      ).rejects.toThrow(/foreign key|violates/);
      await expect(
        admin.query(
          `INSERT INTO proposal_policies (type, basis, threshold_kind) VALUES ('t1', 'family', 'majority')`,
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        admin.query(
          `INSERT INTO proposal_policies (type, basis, threshold_kind) VALUES ('t2', 'member', 'half')`,
        ),
      ).rejects.toThrow(/check constraint/);
    },
  );
});
