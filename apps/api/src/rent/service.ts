import type pg from 'pg';
import { methodAccount, type Clock } from '@barakah/shared';
import type { RentReceipt, RentStreamCreate, RentStreamUpdate } from '@barakah/shared';
import { notFound, badRequest } from '../lib/errors';
import { audit } from '../lib/audit';
import type { Db } from '../lib/tx';
import { postEntries, type LedgerActor } from '../ledger/service';

export interface RentDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface RentActor {
  userId: string;
  ip?: string;
  deviceId?: string | null;
}

export async function createStream(deps: RentDeps, actor: RentActor, input: RentStreamCreate): Promise<string> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      if (input.asset_id) {
        const a = await client.query(`SELECT 1 FROM assets WHERE id = $1`, [input.asset_id]);
        if (a.rowCount === 0) throw notFound('asset.not_found', 'Asset not found');
      }
      const res = await client.query(
        `INSERT INTO rent_streams (asset_id, name, tenant_name, monthly_amount_paisa, due_day, active_from, active_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          input.asset_id ?? null,
          input.name,
          input.tenant_name ?? null,
          input.monthly_amount_paisa.toString(),
          input.due_day,
          input.active_from,
          input.active_to ?? null,
        ],
      );
      const streamId = (res.rows[0] as { id: string }).id;
      await audit(client, {
        actor: actor.userId,
        action: 'rent_stream.create',
        entityType: 'rent_stream',
        entityId: streamId,
        after: { ...input, monthly_amount_paisa: input.monthly_amount_paisa.toString() },
        ip: actor.ip,
        deviceId: actor.deviceId,
      });
      await client.query('COMMIT');
      return streamId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function updateStream(deps: RentDeps, actor: RentActor, id: string, input: RentStreamUpdate): Promise<void> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const exists = await client.query(`SELECT 1 FROM rent_streams WHERE id = $1`, [id]);
      if (exists.rowCount === 0) throw notFound('rent_stream.not_found', 'Rent stream not found');

      const set: string[] = [];
      const values: unknown[] = [];
      const add = (field: string, value: unknown | undefined, serializer?: (v: unknown) => unknown) => {
        if (value === undefined) return;
        values.push(serializer ? serializer(value) : value);
        set.push(`${field} = $${values.length}`);
      };

      add('asset_id', input.asset_id);
      add('name', input.name);
      add('tenant_name', input.tenant_name);
      add('monthly_amount_paisa', input.monthly_amount_paisa, (v) => (v as bigint).toString());
      add('due_day', input.due_day);
      add('active_to', input.active_to);

      if (set.length === 0) {
        await client.query('COMMIT');
        return;
      }

      const before = await client.query(`SELECT * FROM rent_streams WHERE id = $1`, [id]);
      await client.query(`UPDATE rent_streams SET ${set.join(', ')} WHERE id = $${values.length + 1}`, [...values, id]);
      const after = await client.query(`SELECT * FROM rent_streams WHERE id = $1`, [id]);
      const serialize = (r: Record<string, unknown>) => {
        const out = { ...r };
        if (typeof out.monthly_amount_paisa === 'bigint') out.monthly_amount_paisa = out.monthly_amount_paisa.toString();
        return out;
      };
      await audit(client, {
        actor: actor.userId,
        action: 'rent_stream.update',
        entityType: 'rent_stream',
        entityId: id,
        before: serialize(before.rows[0] as Record<string, unknown>),
        after: serialize(after.rows[0] as Record<string, unknown>),
        ip: actor.ip,
        deviceId: actor.deviceId,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function getStream(db: Db, id: string): Promise<Record<string, unknown> | null> {
  const res = await db.query(
    `SELECT s.*, a.name AS asset_name
     FROM rent_streams s
     LEFT JOIN assets a ON a.id = s.asset_id
     WHERE s.id = $1`,
    [id],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0] as Record<string, unknown>;
  if (typeof row.monthly_amount_paisa === 'bigint') row.monthly_amount_paisa = row.monthly_amount_paisa.toString();
  return row;
}

export async function listStreams(db: Db, filters: { limit: number; cursor?: string }): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.cursor) {
    params.push(filters.cursor);
    conditions.push(`id > $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await db.query(
    `SELECT s.*, a.name AS asset_name
     FROM rent_streams s
     LEFT JOIN assets a ON a.id = s.asset_id
     ${where}
     ORDER BY s.active_from DESC, s.id
     LIMIT $${params.length + 1}`,
    [...params, filters.limit + 1],
  );
  const rows = res.rows.slice(0, filters.limit).map((r) => {
    const row = r as Record<string, unknown>;
    if (typeof row.monthly_amount_paisa === 'bigint') row.monthly_amount_paisa = row.monthly_amount_paisa.toString();
    return row;
  });
  const nextCursor = res.rows.length > filters.limit ? (res.rows[filters.limit] as { id: string }).id : undefined;
  return { items: rows, nextCursor };
}

export async function generateExpectedRent(db: Db, period: string): Promise<{ created: number }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw badRequest('period.invalid_format', 'Period must be YYYY-MM');
  }
  const firstDay = `${period}-01`;
  const lastDayRes = await db.query(`SELECT (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date::text AS d`, [firstDay]);
  const lastDay = (lastDayRes.rows[0] as { d: string }).d;

  const res = await db.query(
    `INSERT INTO rent_expected (stream_id, period, amount_paisa, due_date)
     SELECT s.id, $1::char(7), s.monthly_amount_paisa, to_date($1::text || '-' || s.due_day, 'YYYY-MM-DD')
     FROM rent_streams s
     WHERE s.active_from <= $2
       AND (s.active_to IS NULL OR s.active_to >= $3)
     ON CONFLICT (stream_id, period) DO NOTHING
     RETURNING id`,
    [period, firstDay, lastDay],
  );
  return { created: res.rowCount ?? 0 };
}

function rentStatus(row: { amount_paisa: string | bigint; received_paisa: string | bigint; due_date: string }, clock: Clock): string {
  const amount = BigInt(row.amount_paisa);
  const received = BigInt(row.received_paisa);
  if (received >= amount) return 'received';
  if (row.due_date < clock.todayDhaka()) return 'overdue';
  return 'expected';
}

export async function listExpected(
  db: Db,
  clock: Clock,
  filters: { period?: string; stream_id?: string; limit: number; cursor?: string },
): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.period) {
    params.push(filters.period);
    conditions.push(`e.period = $${params.length}`);
  }
  if (filters.stream_id) {
    params.push(filters.stream_id);
    conditions.push(`e.stream_id = $${params.length}`);
  }
  if (filters.cursor) {
    params.push(filters.cursor);
    conditions.push(`e.id > $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await db.query(
    `SELECT e.*, s.name AS stream_name, s.tenant_name, s.due_day, s.asset_id, a.name AS asset_name
     FROM rent_expected e
     JOIN rent_streams s ON s.id = e.stream_id
     LEFT JOIN assets a ON a.id = s.asset_id
     ${where}
     ORDER BY e.due_date DESC, e.id
     LIMIT $${params.length + 1}`,
    [...params, filters.limit + 1],
  );
  const rows = res.rows.slice(0, filters.limit).map((r) => {
    const row = r as Record<string, unknown>;
    for (const key of ['amount_paisa', 'received_paisa']) {
      const v = row[key];
      if (typeof v === 'bigint') row[key] = v.toString();
    }
    row.status = rentStatus(row as { amount_paisa: string | bigint; received_paisa: string | bigint; due_date: string }, clock);
    return row;
  });
  const nextCursor = res.rows.length > filters.limit ? (res.rows[filters.limit] as { id: string }).id : undefined;
  return { items: rows, nextCursor };
}

export async function receiveRent(
  deps: RentDeps,
  actor: RentActor & LedgerActor,
  expectedId: string,
  input: RentReceipt,
): Promise<{ seq: bigint; received_paisa: bigint }> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const rowRes = await client.query(
        `SELECT e.*, s.due_day, s.monthly_amount_paisa
         FROM rent_expected e
         JOIN rent_streams s ON s.id = e.stream_id
         WHERE e.id = $1
         FOR UPDATE`,
        [expectedId],
      );
      if (rowRes.rowCount === 0) throw notFound('rent_expected.not_found', 'Expected rent not found');
      const row = rowRes.rows[0] as {
        id: string;
        stream_id: string;
        period: string;
        amount_paisa: string | bigint;
        received_paisa: string | bigint;
        due_date: string;
      };
      const amount = BigInt(row.amount_paisa);
      const already = BigInt(row.received_paisa);
      if (already >= amount) {
        throw badRequest('rent.already_received', 'This period has already been fully received');
      }
      if (input.amount_paisa > amount - already) {
        throw badRequest('rent.over_receipt', 'Receipt exceeds the remaining expected amount');
      }

      const posted = await postEntries(
        client,
        [
          {
            entry_date: input.paid_at,
            debit: methodAccount(input.method),
            credit: 'RENT_INCOME',
            amount_paisa: input.amount_paisa,
            ref_type: 'rent_receipt',
            ref_id: expectedId,
            memo: input.note ?? `Rent ${row.period}`,
          },
        ],
        actor,
      );

      const upd = await client.query(
        `UPDATE rent_expected SET received_paisa = received_paisa + $2 WHERE id = $1 RETURNING received_paisa`,
        [expectedId, input.amount_paisa.toString()],
      );
      const newReceived = BigInt((upd.rows[0] as { received_paisa: string | bigint }).received_paisa);

      await audit(client, {
        actor: actor.userId,
        action: 'rent.receive',
        entityType: 'rent_expected',
        entityId: expectedId,
        after: {
          amount_paisa: input.amount_paisa.toString(),
          method: input.method,
          paid_at: input.paid_at,
          received_paisa: newReceived.toString(),
          ledger_seq: posted[0]!.seq.toString(),
        },
        ip: actor.ip,
        deviceId: actor.deviceId,
      });

      await client.query('COMMIT');
      return { seq: posted[0]!.seq, received_paisa: newReceived };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}
