import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import { notFound, conflict } from '../lib/errors';
import type { Db } from '../lib/tx';

export interface ConstitutionDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface ClauseInput {
  clause_no: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
}

interface VersionRow {
  id: string;
  version: string;
  file_id: string | null;
  effective_from: string;
  proposal_id: string | null;
  summary: string | null;
  created_at: string;
}

interface ClauseRow {
  id: string;
  clause_no: string;
  title: string | null;
  summary: string | null;
  body: string | null;
}

export interface ConstitutionVersion {
  id: string;
  version: string;
  file_id: string | null;
  effective_from: string;
  summary: string | null;
  proposal_id: string | null;
  created_at: string;
  clauses: ClauseRow[];
}

/**
 * Seed a constitution version and its clauses (spec 18).
 * Used by the auditor-executed `constitution_amendment` proposal executor.
 */
export async function seedConstitutionVersion(
  db: Db,
  version: string,
  fileId: string | null,
  effectiveFrom: string,
  summary: string | null,
  proposalId: string | null,
  clauses: ClauseInput[],
): Promise<{ version_id: string }> {
  const existing = await db.query(`SELECT 1 FROM constitution_versions WHERE version = $1`, [version]);
  if ((existing.rowCount ?? 0) > 0) {
    throw conflict('constitution.version_exists', `Constitution version ${version} already exists`);
  }

  const v = await db.query(
    `INSERT INTO constitution_versions (version, file_id, effective_from, summary, proposal_id)
     VALUES ($1, $2::uuid, $3::date, $4, $5::uuid)
     RETURNING id`,
    [version, fileId, effectiveFrom, summary, proposalId],
  );
  const versionId = (v.rows[0] as { id: string }).id;

  if (clauses.length > 0) {
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const c of clauses) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(versionId, c.clause_no, c.title ?? null, c.summary ?? null, c.body ?? null);
    }
    await db.query(
      `INSERT INTO constitution_clauses (version_id, clause_no, title, summary, body) VALUES ${values.join(', ')}`,
      params,
    );
  }

  return { version_id: versionId };
}

/** All constitution versions, newest effective date first. */
export async function listConstitutionVersions(db: Db): Promise<{ items: VersionRow[] }> {
  const res = await db.query<VersionRow>(
    `SELECT id, version, file_id, effective_from::text AS effective_from, proposal_id, summary, created_at
     FROM constitution_versions
     ORDER BY effective_from DESC, created_at DESC`,
  );
  return { items: res.rows };
}

/** One version with its clauses. Optionally includes whether the given member has acknowledged it. */
export async function getConstitutionVersion(
  db: Db,
  id: string,
  memberId?: string,
): Promise<ConstitutionVersion & { acked_at?: string }> {
  const [vRes, cRes, ackRes] = await Promise.all([
    db.query<VersionRow>(
      `SELECT id, version, file_id, effective_from::text AS effective_from, proposal_id, summary, created_at
       FROM constitution_versions WHERE id = $1`,
      [id],
    ),
    db.query<ClauseRow>(
      `SELECT id, clause_no, title, summary, body
       FROM constitution_clauses WHERE version_id = $1
       ORDER BY clause_no`,
      [id],
    ),
    memberId
      ? db.query<{ acked_at: string }>(
          `SELECT acked_at::text AS acked_at FROM constitution_acks WHERE version_id = $1 AND member_id = $2`,
          [id, memberId],
        )
      : Promise.resolve({ rows: [] } as unknown as pg.QueryResult<{ acked_at: string }>),
  ]);
  const version = vRes.rows[0];
  if (!version) throw notFound('constitution.version_not_found', 'Constitution version not found');
  const ackedAt = ackRes.rows[0]?.acked_at;
  return { ...version, clauses: cRes.rows, ...(ackedAt ? { acked_at: ackedAt } : {}) };
}

/** Substring search across a version's clause titles, summaries and bodies. */
export async function searchClauses(
  db: Db,
  versionId: string,
  q: string,
): Promise<{ items: ClauseRow[] }> {
  const pattern = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const res = await db.query<ClauseRow>(
    `SELECT id, clause_no, title, summary, body
     FROM constitution_clauses
     WHERE version_id = $1
       AND (title ILIKE $2 OR summary ILIKE $2 OR body ILIKE $2)
     ORDER BY clause_no`,
    [versionId, pattern],
  );
  return { items: res.rows };
}

/**
 * Record that a member has acknowledged a constitution version. Idempotent.
 */
export async function acknowledgeVersion(
  db: Db,
  versionId: string,
  memberId: string,
): Promise<{ acked_at: string }> {
  const version = await db.query(`SELECT 1 FROM constitution_versions WHERE id = $1`, [versionId]);
  if ((version.rowCount ?? 0) === 0) {
    throw notFound('constitution.version_not_found', 'Constitution version not found');
  }

  const res = await db.query(
    `INSERT INTO constitution_acks (version_id, member_id, acked_at)
     VALUES ($1, $2, now())
     ON CONFLICT (version_id, member_id) DO NOTHING
     RETURNING acked_at::text AS acked_at`,
    [versionId, memberId],
  );
  if (res.rows[0]) {
    return { acked_at: (res.rows[0] as { acked_at: string }).acked_at };
  }

  const existing = await db.query(
    `SELECT acked_at::text AS acked_at FROM constitution_acks
     WHERE version_id = $1 AND member_id = $2`,
    [versionId, memberId],
  );
  const row = existing.rows[0] as { acked_at: string } | undefined;
  if (!row) throw notFound('constitution.ack_not_found', 'Acknowledgement not found');
  return { acked_at: row.acked_at };
}
