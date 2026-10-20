import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/db-harness';
import { seedFund, type Fund } from '../test/fund-fixture';
import {
  seedConstitutionVersion,
  listConstitutionVersions,
  getConstitutionVersion,
  searchClauses,
  acknowledgeVersion,
} from './service';

describe('constitution', () => {
  let db: TestDb | null = null;
  let fund: Fund;

  beforeAll(async () => {
    db = await createTestDb();
    if (!db) return;
    fund = await seedFund(db.admin);
  });

  afterAll(async () => {
    await db?.close();
  });

  const dbIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!db) return ctx.skip();
      await fn();
    });

  dbIt('versions are listed newest first with clauses', async () => {
    await seedConstitutionVersion(
      db!.admin,
      '1.0',
      null,
      '2026-01-01',
      'Initial constitution',
      null,
      [
        { clause_no: '1.1', title: 'Name', body: 'The fund name is Barakah.' },
        { clause_no: '2.1', title: 'Dues', body: 'Monthly dues are payable by the 20th.' },
      ],
    );

    const v2 = await seedConstitutionVersion(
      db!.admin,
      '2.0',
      null,
      '2026-06-01',
      'Add charity rules',
      null,
      [
        { clause_no: '3.1', title: 'Charity', body: 'Fines are donated to charity at year end.' },
      ],
    );

    const list = await listConstitutionVersions(db!.admin);
    expect(list.items[0]!.version).toBe('2.0');
    expect(list.items[1]!.version).toBe('1.0');

    const detail = await getConstitutionVersion(db!.admin, v2.version_id);
    expect(detail.version).toBe('2.0');
    expect(detail.clauses).toHaveLength(1);
    expect(detail.clauses[0]!.clause_no).toBe('3.1');
  });

  dbIt('search returns clauses whose title, summary or body match', async () => {
    const version = await seedConstitutionVersion(
      db!.admin,
      'search-1',
      null,
      '2026-06-01',
      null,
      null,
      [
        { clause_no: 'A', title: 'Alpha', body: 'apples and apricots' },
        { clause_no: 'B', title: 'Beta', body: 'bananas only' },
        { clause_no: 'C', summary: 'charity summary', body: 'nothing here' },
      ],
    );

    const a = await searchClauses(db!.admin, version.version_id, 'apricot');
    expect(a.items).toHaveLength(1);
    expect(a.items[0]!.clause_no).toBe('A');

    const charity = await searchClauses(db!.admin, version.version_id, 'charity');
    expect(charity.items).toHaveLength(1);
    expect(charity.items[0]!.clause_no).toBe('C');

    const none = await searchClauses(db!.admin, version.version_id, 'zebra');
    expect(none.items).toHaveLength(0);
  });

  dbIt('acknowledgeVersion is idempotent', async () => {
    const version = await seedConstitutionVersion(
      db!.admin,
      'ack-1',
      null,
      '2026-06-01',
      null,
      null,
      [{ clause_no: '1', body: 'ack test' }],
    );

    const first = await acknowledgeVersion(db!.admin, version.version_id, fund.members.M01);
    const second = await acknowledgeVersion(db!.admin, version.version_id, fund.members.M01);
    expect(first.acked_at).toBe(second.acked_at);
  });
});
