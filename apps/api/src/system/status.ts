import { readFile, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type pg from 'pg';
import { bn, formatDateDisplay, toBengaliDigits, toDhakaDate, type Clock } from '@barakah/shared';
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

interface BackupStatusFile {
  ok?: boolean;
  finished?: string;
  size?: number;
}

/** A backup runs at 02:00 every night; anything older than this means at least one night was missed. */
const BACKUP_MAX_AGE_MS = 26 * 3600_000;

function sizeText(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '?';
  const mb = bytes / (1024 * 1024);
  return `${toBengaliDigits(mb >= 10 ? mb.toFixed(0) : mb.toFixed(1))} MB`;
}

const WATCH_TEXT = (bn as unknown as { backupWatch: Record<'unknown' | 'restoreOk' | 'restoreFailed' | 'restoreNone', string> }).backupWatch;

function dateText(iso: string | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return WATCH_TEXT.unknown;
  return formatDateDisplay(toDhakaDate(new Date(iso)));
}

/**
 * The daily backup watch (ASSUMPTIONS 122). The sidecar only reports a backup that fails; one that never
 * runs (the container stopped, cron died) would stay silent. So every morning the API reads the
 * sidecar's status file: no successful backup in 26 hours tells the cashier and auditor (push + SMS),
 * and on Fridays a healthy backup sends them a short push report, so they know the alerts reach them.
 * Outside production a missing status file just means there is no sidecar, and nothing is sent.
 */
export async function runBackupWatch(deps: {
  pool: pg.Pool;
  clock: Clock;
  statusDir: string;
  production: boolean;
}): Promise<'ok' | 'weekly_report' | 'missing' | 'no_sidecar'> {
  const [backup, restore] = (await Promise.all([
    readJson(join(deps.statusDir, 'status.json')),
    readJson(join(deps.statusDir, 'restore-status.json')),
  ])) as [BackupStatusFile | null, BackupStatusFile | null];
  if (!backup && !deps.production) return 'no_sidecar';

  const today = deps.clock.todayDhaka();
  const finished = backup?.finished ? Date.parse(backup.finished) : Number.NaN;
  const fresh = backup?.ok === true && !Number.isNaN(finished) && deps.clock.now().getTime() - finished <= BACKUP_MAX_AGE_MS;

  if (!fresh) {
    await inTransaction(deps.pool, (tx) =>
      queueRoleAlert(tx, deps.clock, ['cashier', 'auditor'], 'backup_missing', { last: backup?.ok ? dateText(backup.finished) : WATCH_TEXT.unknown }, today),
    );
    return 'missing';
  }

  // Friday is the weekly holiday in Bangladesh: the report arrives on a quiet morning.
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (weekday !== 5) return 'ok';
  const restoreText =
    restore?.ok === true
      ? WATCH_TEXT.restoreOk.replace('{date}', dateText(restore.finished))
      : restore
        ? WATCH_TEXT.restoreFailed
        : WATCH_TEXT.restoreNone;
  await inTransaction(deps.pool, (tx) =>
    queueRoleAlert(
      tx,
      deps.clock,
      ['cashier', 'auditor'],
      'backup_weekly_ok',
      { date: dateText(backup.finished), size: sizeText(backup.size), restore: restoreText },
      today,
    ),
  );
  return 'weekly_report';
}
