import type { EntryRemarkCreate } from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { audit } from '../lib/audit';
import { forbidden, notFound } from '../lib/errors';
import { inTransaction, type Db } from '../lib/tx';
import type pg from 'pg';

export interface EntryRemark {
  id: string;
  ledger_seq: string;
  text: string;
  created_at: string;
  by_code: string | null;
  by_name: string | null;
}

const isPrivileged = (user: AuthUser): boolean => user.roles.includes('cashier') || user.roles.includes('auditor');

/** The entry's member, or a 404 when there is no such entry. */
async function entryMember(db: Db, seq: string): Promise<string | null> {
  const res = await db.query(`SELECT member_id FROM ledger_entries WHERE seq = $1::bigint`, [seq]);
  const row = res.rows[0] as { member_id: string | null } | undefined;
  if (!row) throw notFound('ledger.entry_not_found', `Ledger entry #${seq} not found`);
  return row.member_id;
}

/**
 * `GET /ledger/:seq/remarks` (ASSUMPTIONS 128): every remark on one entry, newest first. The newest is
 * the one in force; the older ones are its history and are never changed. Seen by the cashier, the
 * auditor, and the member the entry is about (the same rule as a payment's note).
 */
export async function listEntryRemarks(db: Db, user: AuthUser, seq: string): Promise<{ items: EntryRemark[] }> {
  const memberId = await entryMember(db, seq);
  if (!isPrivileged(user) && memberId !== user.member_id) throw forbidden();
  const res = await db.query(
    `SELECT r.id, r.ledger_seq::text AS ledger_seq, r.text, r.created_at, m.code AS by_code, m.full_name AS by_name
     FROM entry_remarks r
     LEFT JOIN users u ON u.id = r.created_by
     LEFT JOIN members m ON m.id = u.member_id
     WHERE r.ledger_seq = $1::bigint
     ORDER BY r.created_at DESC, r.id DESC`,
    [seq],
  );
  return { items: res.rows as EntryRemark[] };
}

/**
 * `POST /ledger/:seq/remarks` (cashier or auditor): add a remark to an entry afterwards. The ledger row
 * is not touched and the remark is outside the hash chain, so `verify-ledger` is unaffected. A new
 * remark replaces the shown one; the earlier stays in the history. Audited.
 */
export async function addEntryRemark(
  pool: pg.Pool,
  user: AuthUser,
  seq: string,
  input: EntryRemarkCreate,
  ctx: { ip?: string | undefined },
): Promise<{ id: string }> {
  return inTransaction(pool, async (db) => {
    await entryMember(db, seq);
    const ins = await db.query(
      `INSERT INTO entry_remarks (ledger_seq, text, created_by) VALUES ($1::bigint, $2, $3) RETURNING id`,
      [seq, input.text, user.id],
    );
    const id = (ins.rows[0] as { id: string }).id;
    await audit(db, {
      actor: user.id,
      action: 'ledger.remark',
      entityType: 'ledger_entry',
      entityId: seq,
      after: { remark_id: id, text: input.text },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
    return { id };
  });
}
