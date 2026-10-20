import { readFile, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import { verifyLedger } from '../ledger/queries';
import { audit } from '../lib/audit';
import { inTransaction } from '../lib/tx';
import { queueRoleAlert } from '../notifications/role-alert';

export interface SystemDeps {
  pool: pg.Pool;
  clock: Clock;
  statusDir: string;
  filesDir: string;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function setting(pool: pg.Pool, key: string): Promise<unknown | null> {
  const res = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return (res.rows[0] as { value: unknown } | undefined)?.value ?? null;
}

/** Free space on the disk holding `path`; a folder that does not exist yet is measured through its parent. */
async function diskFree(path: string): Promise<{ free_bytes: number; total_bytes: number } | null> {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try {
      const s = await statfs(dir);
      return { free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      if (dirname(dir) === dir) return null;
    }
  }
}

/** What `/system/status` shows (spec 7, 12): backups, restore test, ledger check, job queue and disk. */
export async function systemStatus(deps: SystemDeps) {
  const [backup, restore, verify, offline, queue] = await Promise.all([
    readJson(join(deps.statusDir, 'status.json')),
    readJson(join(deps.statusDir, 'restore-status.json')),
    setting(deps.pool, 'last_ledger_verify'),
    setting(deps.pool, 'offline_copy_confirmed'),
    deps.pool
      .query(`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created','retry','active')`)
      .then((r) => (r.rows[0] as { n: number }).n)
      .catch(() => null),
  ]);
  const disk = await diskFree(deps.filesDir);
  return {
    now: deps.clock.now().toISOString(),
    backup,
    restore_test: restore,
    ledger_verify: verify,
    offline_copy: offline,
    queue_depth: queue,
    disk,
  };
}

/**
 * The daily ledger check (spec 5.6): recompute the hash chain, keep the result for `/system/status`,
 * and on a break tell the cashier and the auditor at once.
 */
export async function runLedgerVerify(pool: pg.Pool, clock: Clock): Promise<{ ok: boolean }> {
  const result = await verifyLedger(pool);
  const value = {
    at: clock.now().toISOString(),
    ok: result.ok,
    count: result.count,
    last_seq: result.last_seq,
    issues: result.issues_total,
  };
  await inTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO settings (key, value) VALUES ('last_ledger_verify', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(value)],
    );
    if (!result.ok) {
      await queueRoleAlert(
        tx,
        clock,
        ['cashier', 'auditor'],
        'ledger_verify_failed',
        { seq: result.issues[0]?.seq ?? '?' },
        `${clock.todayDhaka()}`,
      );
      await audit(tx, { actor: null, action: 'ledger.verify_failed', entityType: 'ledger', entityId: 'chain', after: value });
    }
  });
  return { ok: result.ok };
}

/** The cashier confirms that this month's encrypted backup was copied to the auditor's offline drive (spec 12). */
export async function confirmOfflineCopy(deps: { pool: pg.Pool; clock: Clock }, userId: string, ip?: string): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const value = { on: deps.clock.todayDhaka(), by: userId };
    await tx.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ('offline_copy_confirmed', $1::jsonb, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(value), userId],
    );
    await audit(tx, { actor: userId, action: 'system.offline_copy_confirmed', entityType: 'system', entityId: 'backup', after: value, ip });
  });
}

/** `POST /internal/alert`: the backup sidecar reports a failure. Everyone who can act on it is told, SMS included. */
export async function raiseBackupAlert(pool: pg.Pool, clock: Clock, job: string): Promise<void> {
  await inTransaction(pool, (tx) =>
    queueRoleAlert(tx, clock, ['cashier', 'auditor'], 'backup_failed', { job }, `${job}:${clock.now().getTime()}`),
  );
}
