import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import type { AssetCreate, AssetUpdate, AssetValuationCreate, DocumentAttach } from '@barakah/shared';
import { notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import type { Db } from '../lib/tx';

export interface AssetDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface AssetActor {
  userId: string;
  ip?: string;
  deviceId?: string | null;
}

const SELECT_ASSET_COLUMNS = `
  a.id, a.kind, a.name, a.description, a.location, a.acquired_on, a.cost_paisa, a.quantity::text AS quantity,
  a.unit, a.status, a.sold_on, a.sale_price_paisa, a.legal_owner_name, a.ownership_split, a.compliance,
  a.feasibility_file_id, a.proposal_id, a.created_at,
  (SELECT value_paisa FROM asset_valuations v WHERE v.asset_id = a.id ORDER BY v.as_of DESC, v.created_at DESC LIMIT 1) AS latest_value_paisa,
  (SELECT as_of FROM asset_valuations v WHERE v.asset_id = a.id ORDER BY v.as_of DESC, v.created_at DESC LIMIT 1) AS latest_value_as_of
`;

function serializeBigints(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['cost_paisa', 'sale_price_paisa', 'latest_value_paisa']) {
    const v = out[key];
    if (typeof v === 'bigint') out[key] = v.toString();
  }
  return out;
}

export async function createAsset(deps: AssetDeps, actor: AssetActor, input: AssetCreate): Promise<string> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO assets
           (kind, name, description, location, acquired_on, cost_paisa, quantity, unit, status,
            legal_owner_name, ownership_split, compliance, feasibility_file_id, proposal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          input.kind,
          input.name,
          input.description ?? null,
          input.location ?? null,
          input.acquired_on ?? null,
          input.cost_paisa.toString(),
          input.quantity ?? null,
          input.unit ?? null,
          input.status,
          input.legal_owner_name ?? null,
          input.ownership_split ?? null,
          input.compliance ?? null,
          input.feasibility_file_id ?? null,
          input.proposal_id ?? null,
        ],
      );
      const assetId = (res.rows[0] as { id: string }).id;
      await audit(client, {
        actor: actor.userId,
        action: 'asset.create',
        entityType: 'asset',
        entityId: assetId,
        after: {
          ...input,
          cost_paisa: input.cost_paisa.toString(),
          quantity: input.quantity ?? null,
        },
        ip: actor.ip,
        deviceId: actor.deviceId,
      });
      await client.query('COMMIT');
      return assetId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function updateAsset(deps: AssetDeps, actor: AssetActor, id: string, input: AssetUpdate): Promise<void> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const exists = await client.query(`SELECT 1 FROM assets WHERE id = $1`, [id]);
      if (exists.rowCount === 0) throw notFound('asset.not_found', 'Asset not found');

      const set: string[] = [];
      const values: unknown[] = [];
      const add = (field: string, value: unknown | undefined, serializer?: (v: unknown) => unknown) => {
        if (value === undefined) return;
        values.push(serializer ? serializer(value) : value);
        set.push(`${field} = $${values.length}`);
      };

      add('kind', input.kind);
      add('name', input.name);
      add('description', input.description);
      add('location', input.location);
      add('acquired_on', input.acquired_on);
      add('cost_paisa', input.cost_paisa, (v) => (v as bigint).toString());
      add('quantity', input.quantity);
      add('unit', input.unit);
      add('status', input.status);
      add('legal_owner_name', input.legal_owner_name);
      add('ownership_split', input.ownership_split, JSON.stringify);
      add('compliance', input.compliance, JSON.stringify);
      add('feasibility_file_id', input.feasibility_file_id);
      add('proposal_id', input.proposal_id);
      add('sold_on', input.sold_on);
      add('sale_price_paisa', input.sale_price_paisa, (v) => (v as bigint).toString());

      if (set.length === 0) {
        await client.query('COMMIT');
        return;
      }

      const before = await client.query(`SELECT * FROM assets WHERE id = $1`, [id]);
      await client.query(`UPDATE assets SET ${set.join(', ')} WHERE id = $${values.length + 1}`, [...values, id]);
      const after = await client.query(`SELECT * FROM assets WHERE id = $1`, [id]);
      await audit(client, {
        actor: actor.userId,
        action: 'asset.update',
        entityType: 'asset',
        entityId: id,
        before: serializeBigints(before.rows[0] as Record<string, unknown>),
        after: serializeBigints(after.rows[0] as Record<string, unknown>),
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

export async function getAsset(db: Db, id: string): Promise<Record<string, unknown> | null> {
  const res = await db.query(`SELECT ${SELECT_ASSET_COLUMNS} FROM assets a WHERE a.id = $1`, [id]);
  if (res.rowCount === 0) return null;
  return serializeBigints(res.rows[0] as Record<string, unknown>);
}

export async function listAssets(
  db: Db,
  filters: { status?: string; kind?: string; limit: number; cursor?: string },
): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (filters.cursor) {
    params.push(filters.cursor);
    conditions.push(`id > $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await db.query(
    `SELECT ${SELECT_ASSET_COLUMNS}
     FROM assets a
     ${where}
     ORDER BY a.created_at DESC, a.id
     LIMIT $${params.length + 1}`,
    [...params, filters.limit + 1],
  );
  const rows = res.rows.slice(0, filters.limit).map((r) => serializeBigints(r as Record<string, unknown>));
  const nextCursor = res.rows.length > filters.limit ? (res.rows[filters.limit] as { id: string }).id : undefined;
  return { items: rows, nextCursor };
}

export async function addValuation(
  deps: AssetDeps,
  actor: AssetActor,
  assetId: string,
  input: AssetValuationCreate,
): Promise<string> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const exists = await client.query(`SELECT 1 FROM assets WHERE id = $1`, [assetId]);
      if (exists.rowCount === 0) throw notFound('asset.not_found', 'Asset not found');

      const res = await client.query(
        `INSERT INTO asset_valuations (asset_id, value_paisa, as_of, basis, proposal_id)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [assetId, input.value_paisa.toString(), input.as_of, input.basis ?? null, input.proposal_id ?? null],
      );
      const valuationId = (res.rows[0] as { id: string }).id;
      await audit(client, {
        actor: actor.userId,
        action: 'asset_valuation.create',
        entityType: 'asset_valuation',
        entityId: valuationId,
        after: {
          asset_id: assetId,
          value_paisa: input.value_paisa.toString(),
          as_of: input.as_of,
          basis: input.basis,
          proposal_id: input.proposal_id,
        },
        ip: actor.ip,
        deviceId: actor.deviceId,
      });
      await client.query('COMMIT');
      return valuationId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function listValuations(db: Db, assetId: string): Promise<Record<string, unknown>[]> {
  const res = await db.query(
    `SELECT id, value_paisa, as_of::text AS as_of, basis, proposal_id, created_at
     FROM asset_valuations
     WHERE asset_id = $1
     ORDER BY as_of DESC, created_at DESC`,
    [assetId],
  );
  return res.rows.map((r) => {
    const row = r as Record<string, unknown>;
    const out = { ...row };
    if (typeof out.value_paisa === 'bigint') out.value_paisa = out.value_paisa.toString();
    return out;
  });
}

export async function attachDocument(
  deps: AssetDeps,
  actor: AssetActor,
  assetId: string,
  input: DocumentAttach,
): Promise<string> {
  return deps.pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const exists = await client.query(`SELECT 1 FROM assets WHERE id = $1`, [assetId]);
      if (exists.rowCount === 0) throw notFound('asset.not_found', 'Asset not found');

      const res = await client.query(
        `INSERT INTO documents (file_id, entity_type, entity_id, doc_type, title)
         VALUES ($1,'asset',$2,$3,$4)
         RETURNING id`,
        [input.file_id, assetId, input.doc_type ?? null, input.title ?? null],
      );
      const documentId = (res.rows[0] as { id: string }).id;
      await audit(client, {
        actor: actor.userId,
        action: 'document.attach',
        entityType: 'document',
        entityId: documentId,
        after: { file_id: input.file_id, entity_type: 'asset', entity_id: assetId, doc_type: input.doc_type, title: input.title },
        ip: actor.ip,
        deviceId: actor.deviceId,
      });
      await client.query('COMMIT');
      return documentId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function listDocuments(db: Db, assetId: string): Promise<Record<string, unknown>[]> {
  const res = await db.query(
    `SELECT d.id, d.file_id, d.doc_type, d.title, d.created_at, f.mime, f.size_bytes, f.sha256
     FROM documents d
     JOIN files f ON f.id = d.file_id
     WHERE d.entity_type = 'asset' AND d.entity_id = $1
     ORDER BY d.created_at DESC`,
    [assetId],
  );
  return res.rows as Record<string, unknown>[];
}
