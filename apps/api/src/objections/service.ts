import type pg from 'pg';
import type { Clock, ObjectionCreate, ObjectionResolve, ObjectionsQuery } from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { audit } from '../lib/audit';
import { decodeCursor, encodeCursor, tsKey } from '../lib/cursor';
import { conflict, notFound } from '../lib/errors';
import { inTransaction } from '../lib/tx';

export interface ObjectionDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface ClientCtx {
  ip?: string | undefined;
}

/**
 * `POST /objections` (spec 5.12): any active member can object to any ledger row. The row gets an
 * open-objection badge in `/ledger` and, once periods can be locked (Phase 5), the period cannot be
 * locked until the auditor has answered. One open objection per member and row.
 */
export async function createObjection(
  deps: ObjectionDeps,
  user: AuthUser,
  input: ObjectionCreate,
  ctx: ClientCtx,
): Promise<{ id: string; status: 'open' }> {
  return inTransaction(deps.pool, async (tx) => {
    const row = await tx.query(`SELECT 1 FROM ledger_entries WHERE seq = $1::bigint`, [
      input.ledger_seq,
    ]);
    if ((row.rowCount ?? 0) === 0) {
      throw notFound('ledger.entry_not_found', `Ledger entry #${input.ledger_seq} not found`);
    }
    // Serialise a member's double-click: the second request waits, then sees the first.
    await tx.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [user.member_id]);
    const dup = await tx.query(
      `SELECT id FROM objections WHERE ledger_seq = $1::bigint AND member_id = $2 AND status = 'open'`,
      [input.ledger_seq, user.member_id],
    );
    if ((dup.rowCount ?? 0) > 0) {
      throw conflict('objection.already_open', 'You already have an open objection on this entry', {
        objection_id: (dup.rows[0] as { id: string }).id,
      });
    }
    const ins = await tx.query(
      `INSERT INTO objections (ledger_seq, member_id, text) VALUES ($1::bigint, $2, $3) RETURNING id`,
      [input.ledger_seq, user.member_id, input.text],
    );
    const id = (ins.rows[0] as { id: string }).id;
    await audit(tx, {
      actor: user.id,
      action: 'objection.create',
      entityType: 'objection',
      entityId: id,
      after: { ledger_seq: input.ledger_seq, text: input.text },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
    return { id, status: 'open' as const };
  });
}

/** `GET /objections`: open objections are as public as the ledger they are about. */
export async function listObjections(
  deps: ObjectionDeps,
  q: ObjectionsQuery,
): Promise<{ items: unknown[]; next_cursor: string | null }> {
  const cursor = decodeCursor(q.cursor, 2); // [created_at, id]
  const res = await deps.pool.query(
    `SELECT o.id, o.ledger_seq::text AS ledger_seq, o.member_id, m.code AS member_code,
            m.full_name AS member_name, o.text, o.status, o.resolution, o.created_at, o.resolved_at,
            rm.code AS resolved_by_code, ${tsKey('o.created_at')} AS created_key,
            e.amount_paisa::text AS entry_amount_paisa, e.debit_account AS entry_debit,
            e.credit_account AS entry_credit, e.entry_date::text AS entry_date
     FROM objections o
     JOIN members m ON m.id = o.member_id
     JOIN ledger_entries e ON e.seq = o.ledger_seq
     LEFT JOIN users ru ON ru.id = o.resolved_by
     LEFT JOIN members rm ON rm.id = ru.member_id
     WHERE ($1::text IS NULL OR o.status = $1)
       AND ($2::bigint IS NULL OR o.ledger_seq = $2)
       AND ($3::uuid IS NULL OR o.member_id = $3)
       AND ($4::timestamptz IS NULL OR (o.created_at, o.id) < ($4::timestamptz, $5::uuid))
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $6`,
    [
      q.status ?? null,
      q.ledger_seq ?? null,
      q.member_id ?? null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      q.limit + 1,
    ],
  );
  const rows = res.rows as Array<Record<string, unknown> & { id: string; created_key: string }>;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ created_key: _k, ...r }) => r),
    next_cursor: rows.length > q.limit && last ? encodeCursor([last.created_key, last.id]) : null,
  };
}

/** `PATCH /objections/:id` (auditor): answer with a note, as `resolved` or `dismissed`. */
export async function resolveObjection(
  deps: ObjectionDeps,
  user: AuthUser,
  id: string,
  input: ObjectionResolve,
  ctx: ClientCtx,
): Promise<{ id: string; status: string }> {
  return inTransaction(deps.pool, async (tx) => {
    const cur = await tx.query(`SELECT status FROM objections WHERE id = $1 FOR UPDATE`, [id]);
    const row = cur.rows[0] as { status: string } | undefined;
    if (!row) throw notFound('objection.not_found', 'Objection not found');
    if (row.status !== 'open') {
      throw conflict('objection.already_decided', `This objection is already ${row.status}`);
    }
    await tx.query(
      `UPDATE objections SET status = $2, resolution = $3, resolved_by = $4, resolved_at = $5
       WHERE id = $1`,
      [id, input.status, input.resolution, user.id, deps.clock.now()],
    );
    await audit(tx, {
      actor: user.id,
      action: 'objection.resolve',
      entityType: 'objection',
      entityId: id,
      before: { status: 'open' },
      after: { status: input.status, resolution: input.resolution },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
    return { id, status: input.status };
  });
}
