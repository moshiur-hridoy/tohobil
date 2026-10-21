import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFakeClock, type Clock } from '@barakah/shared';
import { buildApp } from '../app';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

const START = new Date('2026-11-05T03:00:00Z'); // 09:00 Dhaka
let clock: Clock;

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M03' | 'M05' | 'M07', TestSession>;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: who ? { authorization: `Bearer ${who}` } : undefined,
    payload,
  });

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  clock = createFakeClock(START);
  app = await buildApp({ env: testEnv, db: db.app, clock });
  fund = await seedFund(db.admin);
  for (const code of ['M01', 'M02', 'M03', 'M05', 'M07'] as const) {
    s[code] = await activateSession(app, db, clock, fund, code);
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn();
  });
}

describe('proposals lifecycle', () => {
  dbIt('creates a general proposal as an active member', async () => {
    const res = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Should we meet every month?',
      payload: { text: 'Monthly meetings' },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { id: string; status: string };
    expect(json.id).toBeTruthy();
    expect(json.status).toBe('draft');
  });

  dbIt('rejects proposal creation by a suspended member', async () => {
    await q(`UPDATE members SET status = 'suspended' WHERE id = $1`, [fund.members.M02]);
    const res = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Suspended member',
      payload: { text: 'hello' },
    });
    expect(res.statusCode).toBe(403);
    await q(`UPDATE members SET status = 'active' WHERE id = $1`, [fund.members.M02]);
  });

  dbIt('opens a proposal, snapshots voters and computes threshold', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Open me',
      payload: { text: 'test' },
    });
    const createdJson = created.json() as { id: string; status: string };
    expect(createdJson.id).toBeTruthy();
    const id = createdJson.id;

    const open = await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });
    expect(open.statusCode).toBe(200);

    const detail = (await call('GET', `/proposals/${id}`, s.M02.access_token)).json() as {
      status: string;
      eligible_count: number;
      threshold: number;
      voters: Array<{ member_id: string }>;
    };
    expect(detail.status).toBe('open');
    expect(detail.eligible_count).toBe(8); // all fixture members active
    expect(detail.threshold).toBe(5); // floor(8/2)+1
    expect(detail.voters.some((v) => v.member_id === fund.members.M02)).toBe(true);
  });

  dbIt('excludes the subject member from voting', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'suspension',
      title: 'Suspend M03',
      payload: { member_id: fund.members.M03, reason: 'test' },
    });
    const id = (created.json() as { id: string }).id;

    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });

    const detail = (await call('GET', `/proposals/${id}`, s.M02.access_token)).json() as {
      voters: Array<{ member_id: string }>;
    };
    expect(detail.voters.some((v) => v.member_id === fund.members.M03)).toBe(false);
  });

  dbIt('votes and allows changing a vote', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Vote test',
      payload: { text: 'vote' },
    });
    const id = (created.json() as { id: string }).id;
    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });

    const v1 = await call('POST', `/proposals/${id}/vote`, s.M02.access_token, { choice: 'yes' });
    expect(v1.statusCode).toBe(200);

    const v2 = await call('POST', `/proposals/${id}/vote`, s.M02.access_token, { choice: 'no' });
    expect(v2.statusCode).toBe(200);

    // Another member votes too; while the vote is open nobody sees how others voted or the running tally.
    expect((await call('POST', `/proposals/${id}/vote`, s.M03.access_token, { choice: 'yes' })).statusCode).toBe(200);

    const detail = (await call('GET', `/proposals/${id}`, s.M02.access_token)).json() as {
      counts: { yes: number; no: number; abstain: number };
      ballots_hidden: boolean;
      votes: Array<{ choice: string; member_id: string }>;
      voters: Array<{ member_id: string; voted: boolean }>;
    };
    expect(detail.ballots_hidden).toBe(true);
    // Everyone can see who has voted (never what) while the vote is open.
    const votedIds = detail.voters.filter((v) => v.voted).map((v) => v.member_id).sort();
    expect(votedIds).toEqual([fund.members.M02, fund.members.M03].sort());
    expect(detail.voters.some((v) => !v.voted)).toBe(true);
    expect(detail.counts).toMatchObject({ yes: 0, no: 0, abstain: 0 });
    expect(detail.votes).toHaveLength(1);
    expect(detail.votes[0]!.choice).toBe('no');
    expect(detail.votes[0]!.member_id).toBe(fund.members.M02);

    const list = (await call('GET', '/proposals?limit=50', s.M02.access_token)).json() as {
      items: Array<{ id: string; counts: { yes: number; no: number }; ballots_hidden: boolean }>;
    };
    const listed = list.items.find((p) => p.id === id)!;
    expect(listed.ballots_hidden).toBe(true);
    expect(listed.counts.yes + listed.counts.no).toBe(0);
  });

  dbIt('rejects voting by a non-eligible subject member', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'suspension',
      title: 'Suspend M02',
      payload: { member_id: fund.members.M02, reason: 'test' },
    });
    const id = (created.json() as { id: string }).id;
    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });

    const res = await call('POST', `/proposals/${id}/vote`, s.M02.access_token, { choice: 'yes' });
    expect(res.statusCode).toBe(403);
  });

  dbIt('closes early only when decided', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Decided',
      payload: { text: 'decided' },
    });
    const id = (created.json() as { id: string }).id;
    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });

    // 5 yes votes reaches threshold 5.
    for (const code of ['M01', 'M02', 'M03', 'M05', 'M07'] as const) {
      await call('POST', `/proposals/${id}/vote`, s[code].access_token, { choice: 'yes' });
    }

    const closed = await call('POST', `/proposals/${id}/close-early`, s.M01.access_token);
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe('approved');

    const detail = (await call('GET', `/proposals/${id}`, s.M02.access_token)).json() as { status: string };
    expect(detail.status).toBe('approved');
  });

  dbIt('closes a distribution early when share threshold is reached', async () => {
    const created = await call('POST', '/proposals', s.M01.access_token, {
      type: 'distribution',
      title: 'Distribution close-early',
      payload: { total_paisa: '100000', source_account: 'CASH' },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;
    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });

    // M01(2) + M02(4) + M03(1) + M05(3) + M07(4) = 14 shares > threshold 11.
    for (const code of ['M01', 'M02', 'M03', 'M05', 'M07'] as const) {
      const res = await call('POST', `/proposals/${id}/vote`, s[code].access_token, { choice: 'yes' });
      expect(res.statusCode).toBe(200);
    }

    const closed = await call('POST', `/proposals/${id}/close-early`, s.M01.access_token);
    expect(closed.statusCode).toBe(200);
    expect((closed.json() as { status: string }).status).toBe('approved');
  });

  dbIt('refuses close-early when not decided', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Undecided',
      payload: { text: 'undecided' },
    });
    const id = (created.json() as { id: string }).id;
    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: '2099-01-01T00:00:00Z',
    });

    const closed = await call('POST', `/proposals/${id}/close-early`, s.M01.access_token);
    expect(closed.statusCode).toBe(409);
  });

  dbIt('cancels a draft proposal', async () => {
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Cancel me',
      payload: { text: 'cancel' },
    });
    const id = (created.json() as { id: string }).id;
    const res = await call('POST', `/proposals/${id}/cancel`, s.M01.access_token);
    expect(res.statusCode).toBe(200);
  });

  dbIt('finalizes open proposals automatically when closes_at passes', async () => {
    const closesAt = new Date(START.getTime() + 2 * 60 * 60 * 1000); // 2 hours later
    const created = await call('POST', '/proposals', s.M02.access_token, {
      type: 'general',
      title: 'Timed close',
      payload: { text: 'timed' },
    });
    const id = (created.json() as { id: string }).id;
    await call('POST', `/proposals/${id}/open`, s.M01.access_token, {
      closes_at: closesAt.toISOString(),
    });

    // Move clock past closes_at and trigger finalize.
    clock = createFakeClock(new Date(closesAt.getTime() + 60_000));
    const { finalizeDueProposals } = await import('../proposals/service');
    await finalizeDueProposals({ pool: db!.app, clock });

    const detail = (await call('GET', `/proposals/${id}`, s.M02.access_token)).json() as { status: string };
    expect(['approved', 'rejected']).toContain(detail.status);
    expect(detail.status).not.toBe('open');
  });
});
