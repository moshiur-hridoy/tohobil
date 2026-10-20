import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import type { Db } from '../lib/tx';

export interface ContactLogRow {
  id: string;
  member_id: string;
  kind: 'call' | 'message' | 'email' | 'registered_letter' | 'visit';
  outcome: string | null;
  note: string | null;
  at: Date;
  by: string;
}

export async function addContactLogEntry(
  db: Db,
  memberId: string,
  kind: ContactLogRow['kind'],
  outcome: string | null,
  note: string | null,
  actorId: string,
): Promise<{ id: string }> {
  const member = await db.query(`SELECT 1 FROM members WHERE id = $1`, [memberId]);
  if ((member.rowCount ?? 0) === 0) {
    throw notFound('member.not_found', 'Member not found');
  }

  const res = await db.query(
    `INSERT INTO member_contact_log (member_id, kind, outcome, note, by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [memberId, kind, outcome ?? null, note ?? null, actorId],
  );
  const id = (res.rows[0] as { id: string }).id;

  await audit(db, {
    actor: actorId,
    action: 'member.contact_log',
    entityType: 'member',
    entityId: memberId,
    after: { id, kind, outcome, note },
    ip: undefined,
    deviceId: null,
  });

  return { id };
}

export async function listContactLog(
  db: Db,
  memberId: string,
  limit: number,
): Promise<{ items: Array<Record<string, unknown>> }> {
  const member = await db.query(`SELECT 1 FROM members WHERE id = $1`, [memberId]);
  if ((member.rowCount ?? 0) === 0) {
    throw notFound('member.not_found', 'Member not found');
  }

  const res = await db.query(
    `SELECT l.id, l.kind, l.outcome, l.note, l.at, l.by, u.full_name AS by_name
     FROM member_contact_log l
     LEFT JOIN users us ON us.id = l.by
     LEFT JOIN members u ON u.id = us.member_id
     WHERE l.member_id = $1
     ORDER BY l.at DESC
     LIMIT $2`,
    [memberId, Math.max(1, Math.min(limit, 200))],
  );

  return {
    items: (res.rows as Array<ContactLogRow & { by_name: string | null }>).map((r) => ({
      id: r.id,
      kind: r.kind,
      outcome: r.outcome,
      note: r.note,
      at: r.at.toISOString(),
      by: r.by,
      by_name: r.by_name,
    })),
  };
}
