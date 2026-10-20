import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import type { AssetComplete, AssetCreate, AssetPayment, AssetUpdate, DocumentAttach } from '@barakah/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { inTransaction, type Db } from '../lib/tx';
import { postEntries } from '../ledger/service';

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
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `INSERT INTO assets
         (kind, name, description, location, cost_paisa, quantity, unit, status,
          legal_owner_name, ownership_split, feasibility_file_id)
       VALUES ($1,$2,$3,$4,0,$5,$6,'planned',$7,$8,$9)
       RETURNING id`,
      [
        input.kind,
        input.name,
        input.description ?? null,
        input.location ?? null,
        input.quantity ?? null,
        input.unit ?? null,
        input.legal_owner_name ?? null,
        input.ownership_split ? JSON.stringify(input.ownership_split) : null,
        input.feasibility_file_id ?? null,
      ],
    );
    const assetId = (res.rows[0] as { id: string }).id;
    await audit(tx, {
      actor: actor.userId,
      action: 'asset.create',
      entityType: 'asset',
      entityId: assetId,
      after: { ...input, status: 'planned' },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return assetId;
  });
}

export async function updateAsset(deps: AssetDeps, actor: AssetActor, id: string, input: AssetUpdate): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const before = await tx.query(`SELECT * FROM assets WHERE id = $1 FOR UPDATE`, [id]);
    if (before.rowCount === 0) throw notFound('asset.not_found', 'Asset not found');

    const set: string[] = [];
    const values: unknown[] = [];
    const add = (field: string, value: unknown | undefined, serializer?: (v: unknown) => unknown) => {
      if (value === undefined) return;
      values.push(serializer ? serializer(value) : value);
      set.push(`${field} = $${values.length}`);
    };
    add('name', input.name);
    add('description', input.description);
    add('location', input.location);
    add('acquired_on', input.acquired_on);
    add('quantity', input.quantity);
    add('unit', input.unit);
    add('legal_owner_name', input.legal_owner_name);
    add('ownership_split', input.ownership_split, JSON.stringify);
    add('compliance', input.compliance, JSON.stringify);
    add('feasibility_file_id', input.feasibility_file_id);
    if (set.length === 0) return;

    await tx.query(`UPDATE assets SET ${set.join(', ')} WHERE id = $${values.length + 1}`, [...values, id]);
    const after = await tx.query(`SELECT * FROM assets WHERE id = $1`, [id]);
    await audit(tx, {
      actor: actor.userId,
      action: 'asset.update',
      entityType: 'asset',
      entityId: id,
      before: serializeBigints(before.rows[0] as Record<string, unknown>),
      after: serializeBigints(after.rows[0] as Record<string, unknown>),
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
  });
}

interface AcquiringAsset {
  id: string;
  kind: string;
  status: string;
  cost_paisa: string;
  proposal_id: string | null;
  ownership_split: Array<{ shares: number }> | null;
}

async function lockAsset(tx: Db, id: string): Promise<AcquiringAsset> {
  const res = await tx.query(
    `SELECT id, kind, status, cost_paisa::text AS cost_paisa, proposal_id, ownership_split
     FROM assets WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const asset = res.rows[0] as AcquiringAsset | undefined;
  if (!asset) throw notFound('asset.not_found', 'Asset not found');
  return asset;
}

/**
 * Another payment on land or a house still being acquired (spec 5.11). Posts
 * `DR INVESTMENTS_AT_COST, CR <account>`, raises the asset's cost (NAV counts an acquiring asset at
 * what has been paid, 19.2) and never goes past the maximum the members approved.
 */
export async function payAssetInstalment(
  deps: AssetDeps,
  actor: AssetActor,
  assetId: string,
  input: AssetPayment,
): Promise<{ ledger_seq: string; paid_paisa: string }> {
  return inTransaction(deps.pool, async (tx) => {
    const asset = await lockAsset(tx, assetId);
    if (asset.status !== 'acquiring') {
      throw conflict('asset.not_acquiring', 'Only an asset that is still being acquired takes staged payments');
    }
    const paid = BigInt(asset.cost_paisa) + input.amount_paisa;
    if (asset.proposal_id) {
      const approved = await tx.query(`SELECT payload->>'max_amount_paisa' AS max FROM proposals WHERE id = $1`, [
        asset.proposal_id,
      ]);
      const max = (approved.rows[0] as { max: string | null } | undefined)?.max;
      if (max && paid > BigInt(max)) {
        throw badRequest('asset.exceeds_approved', 'Total paid would exceed the maximum the members approved');
      }
    }
    const posted = await postEntries(
      tx as pg.PoolClient,
      [
        {
          entry_date: deps.clock.todayDhaka(),
          debit: 'INVESTMENTS_AT_COST',
          credit: input.account,
          amount_paisa: input.amount_paisa,
          member_id: null,
          ref_type: 'asset_payment',
          ref_id: assetId,
          memo: input.note,
        },
      ],
      { userId: actor.userId, ip: actor.ip, deviceId: actor.deviceId },
    );
    await tx.query(`UPDATE assets SET cost_paisa = $2::bigint WHERE id = $1`, [assetId, paid.toString()]);
    await audit(tx, {
      actor: actor.userId,
      action: 'asset.payment',
      entityType: 'asset',
      entityId: assetId,
      after: { amount_paisa: input.amount_paisa.toString(), paid_paisa: paid.toString(), account: input.account },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return { ledger_seq: posted[0]!.seq.toString(), paid_paisa: paid.toString() };
  });
}

/**
 * The cashier marks an acquisition complete: acquiring -> held. It needs a note and a document, and
 * land or a house also needs a deed and an ownership split that covers every share in the fund
 * (spec 5.11 and 18.7). From then on the asset is valued by `valuation_update` proposals.
 */
export async function completeAcquisition(
  deps: AssetDeps,
  actor: AssetActor,
  assetId: string,
  input: AssetComplete,
): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const asset = await lockAsset(tx, assetId);
    if (asset.status !== 'acquiring') {
      throw conflict('asset.not_acquiring', 'Only an asset that is still being acquired can be completed');
    }
    const docs = await tx.query(
      `SELECT doc_type FROM documents WHERE entity_type = 'asset' AND entity_id = $1`,
      [assetId],
    );
    if (docs.rowCount === 0) {
      throw badRequest('asset.document_required', 'Attach a document before completing the acquisition');
    }
    if (asset.kind === 'land' || asset.kind === 'house') {
      if (!docs.rows.some((d) => (d as { doc_type: string | null }).doc_type === 'deed')) {
        throw badRequest('asset.deed_required', 'Attach the deed before completing a land or house acquisition');
      }
      const total = await tx.query(
        `SELECT COALESCE(SUM(shares_on(m.id, $1::date)), 0)::int AS total
         FROM members m WHERE m.status IN ('active','warning','suspended','deceased')`,
        [deps.clock.todayDhaka()],
      );
      const fundShares = (total.rows[0] as { total: number }).total;
      const split = (asset.ownership_split ?? []).reduce((sum, o) => sum + o.shares, 0);
      if (split !== fundShares) {
        throw badRequest('asset.ownership_split_mismatch', `Ownership split (${split}) must equal all shares in the fund (${fundShares})`);
      }
    }
    await tx.query(`UPDATE assets SET status = 'held' WHERE id = $1`, [assetId]);
    await audit(tx, {
      actor: actor.userId,
      action: 'asset.complete',
      entityType: 'asset',
      entityId: assetId,
      after: { note: input.note },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
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
