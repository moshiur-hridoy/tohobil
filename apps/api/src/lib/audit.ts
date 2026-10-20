import type { Db } from './tx';

export interface AuditEntry {
  actor?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | undefined;
  deviceId?: string | null;
}

/**
 * Append one audit row. Call it with the transaction client so the audit row commits or rolls back
 * together with the change it describes (spec 4).
 *
 * Never put a PIN, activation code, refresh token or TOTP secret in `before`/`after`.
 * `before`/`after` are jsonb: money inside them must already be decimal strings, not bigint
 * (JSON.stringify throws on bigint).
 */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.actor ?? null,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.ip ?? null,
      e.deviceId ?? null,
    ],
  );
}
