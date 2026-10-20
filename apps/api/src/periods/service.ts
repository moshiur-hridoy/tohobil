import type pg from 'pg';
import { periodEnd, periodStart, type Clock, type ReconciliationSubmit } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { toBigInt } from '../lib/money';
import { inTransaction, type Db } from '../lib/tx';
import { queueRoleAlert } from '../notifications/role-alert';
import { formatBDT } from '@barakah/shared';

export const CASH_ACCOUNTS = ['CASH', 'BANK', 'BKASH', 'NAGAD'] as const;

export interface PeriodDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface PeriodActor {
  userId: string;
  ip?: string | undefined;
  deviceId?: string | null | undefined;
}

/** What the books say each cash account held at the end of the month. */
export async function systemBalances(db: Db, period: string): Promise<Record<string, bigint>> {
  const res = await db.query(
    `SELECT a.code,
            COALESCE(SUM(CASE WHEN e.debit_account = a.code THEN e.amount_paisa ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN e.credit_account = a.code THEN e.amount_paisa ELSE 0 END), 0) AS balance
     FROM accounts a
     LEFT JOIN ledger_entries e
       ON (e.debit_account = a.code OR e.credit_account = a.code) AND e.entry_date <= $1::date
     WHERE a.code = ANY($2::text[])
     GROUP BY a.code`,
    [periodEnd(period), [...CASH_ACCOUNTS]],
  );
  return Object.fromEntries((res.rows as Array<{ code: string; balance: string }>).map((r) => [r.code, toBigInt(r.balance)]));
}

function assertEnded(deps: PeriodDeps, period: string): void {
  if (periodEnd(period) > deps.clock.todayDhaka()) {
    throw badRequest('period.not_ended', 'A month can only be reconciled once its last day has come');
  }
}

/**
 * The cashier's month-end count (spec 5.12). The books' figure is computed here, never supplied, so
 * a count can only be compared with the ledger, not tuned to match it. Re-submitting is allowed until
 * the auditor approves.
 */
export async function submitReconciliation(
  deps: PeriodDeps,
  actor: PeriodActor,
  input: ReconciliationSubmit,
): Promise<{ period: string; difference_paisa: string }> {
  assertEnded(deps, input.period);
  return inTransaction(deps.pool, async (tx) => {
    const approved = await tx.query(
      `SELECT 1 FROM reconciliations WHERE period = $1 AND approved_at IS NOT NULL LIMIT 1`,
      [input.period],
    );
    if ((approved.rowCount ?? 0) > 0) throw conflict('reconciliation.already_approved', 'This month is already approved');

    const books = await systemBalances(tx, input.period);
    let totalDiff = 0n;
    const mismatches: Array<{ account: string; diff: bigint }> = [];
    for (const row of input.entries) {
      const system = books[row.account] ?? 0n;
      const diff = row.actual_balance_paisa - system;
      if (diff !== 0n && !row.note?.trim()) {
        throw badRequest('reconciliation.note_required', `A note is required for ${row.account}: it differs from the books`);
      }
      totalDiff += diff;
      if (diff !== 0n) mismatches.push({ account: row.account, diff });
      await tx.query(
        `INSERT INTO reconciliations (period, account, system_balance_paisa, actual_balance_paisa, note, submitted_by)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6)
         ON CONFLICT (period, account) DO UPDATE
           SET system_balance_paisa = EXCLUDED.system_balance_paisa,
               actual_balance_paisa = EXCLUDED.actual_balance_paisa,
               note = EXCLUDED.note, submitted_by = EXCLUDED.submitted_by`,
        [input.period, row.account, system.toString(), row.actual_balance_paisa.toString(), row.note?.trim() ?? null, actor.userId],
      );
    }
    await tx.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [input.period]);
    for (const m of mismatches) {
      await queueRoleAlert(
        tx,
        deps.clock,
        ['auditor'],
        'reconciliation_mismatch',
        { period: input.period, account: m.account, diff: formatBDT(m.diff < 0n ? -m.diff : m.diff, { digits: 'bn' }) },
        `${input.period}:${m.account}:${deps.clock.now().getTime()}`,
      );
    }
    await audit(tx, {
      actor: actor.userId,
      action: 'reconciliation.submit',
      entityType: 'period',
      entityId: input.period,
      after: { total_difference_paisa: totalDiff.toString(), mismatches: mismatches.length },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return { period: input.period, difference_paisa: totalDiff.toString() };
  });
}

export async function listReconciliations(db: Db, period: string) {
  const res = await db.query(
    `SELECT account, system_balance_paisa::text AS system_balance_paisa,
            actual_balance_paisa::text AS actual_balance_paisa, difference_paisa::text AS difference_paisa,
            note, approved_at
     FROM reconciliations WHERE period = $1 ORDER BY account`,
    [period],
  );
  return { period, items: res.rows };
}

/** The auditor approves a month's count once all four accounts are in. Never their own submission. */
export async function approveReconciliation(deps: PeriodDeps, actor: PeriodActor, period: string): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const rows = await tx.query(
      `SELECT account, approved_at, submitted_by FROM reconciliations WHERE period = $1 FOR UPDATE`,
      [period],
    );
    if (rows.rowCount !== CASH_ACCOUNTS.length) {
      throw badRequest('reconciliation.incomplete', 'All four cash accounts must be counted first');
    }
    if (rows.rows.every((r) => (r as { approved_at: Date | null }).approved_at)) {
      throw conflict('reconciliation.already_approved', 'This month is already approved');
    }
    if (rows.rows.some((r) => (r as { submitted_by: string }).submitted_by === actor.userId)) {
      throw conflict('reconciliation.self_approval', 'You cannot approve your own count');
    }
    await tx.query(`UPDATE reconciliations SET approved_by = $2, approved_at = $3 WHERE period = $1`, [
      period,
      actor.userId,
      deps.clock.now(),
    ]);
    await audit(tx, {
      actor: actor.userId,
      action: 'reconciliation.approve',
      entityType: 'period',
      entityId: period,
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
  });
}

/**
 * Lock a month (spec 5.12): no ledger entry can be dated in it afterwards. Needs an approved count and
 * no open objection on any entry of that month.
 */
export async function lockPeriod(deps: PeriodDeps, actor: PeriodActor, period: string): Promise<void> {
  assertEnded(deps, period);
  await inTransaction(deps.pool, async (tx) => {
    await tx.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [period]);
    const row = await tx.query(`SELECT locked_at FROM periods WHERE period = $1 FOR UPDATE`, [period]);
    if ((row.rows[0] as { locked_at: Date | null }).locked_at) throw conflict('period.already_locked', 'This month is already locked');

    const counted = await tx.query(
      `SELECT count(*)::int AS n, count(approved_at)::int AS approved FROM reconciliations WHERE period = $1`,
      [period],
    );
    const c = counted.rows[0] as { n: number; approved: number };
    if (c.n !== CASH_ACCOUNTS.length || c.approved !== CASH_ACCOUNTS.length) {
      throw badRequest('period.not_reconciled', 'The month needs an approved cash count before it can be locked');
    }
    const open = await tx.query(
      `SELECT count(*)::int AS n FROM objections o JOIN ledger_entries e ON e.seq = o.ledger_seq
       WHERE o.status = 'open' AND e.entry_date BETWEEN $1::date AND $2::date`,
      [periodStart(period), periodEnd(period)],
    );
    const openCount = (open.rows[0] as { n: number }).n;
    if (openCount > 0) {
      throw conflict('period.open_objections', 'Resolve the open objections in this month first', { open: openCount });
    }
    await tx.query(`UPDATE periods SET locked_at = $2, locked_by = $3 WHERE period = $1`, [period, deps.clock.now(), actor.userId]);
    await audit(tx, {
      actor: actor.userId,
      action: 'period.lock',
      entityType: 'period',
      entityId: period,
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
  });
}

export async function listPeriods(db: Db, year?: string) {
  const res = await db.query(
    `SELECT p.period, p.locked_at,
            (SELECT count(*)::int FROM reconciliations r WHERE r.period = p.period) AS counted_accounts,
            (SELECT count(r.approved_at)::int FROM reconciliations r WHERE r.period = p.period) AS approved_accounts,
            (SELECT count(*)::int FROM objections o JOIN ledger_entries e ON e.seq = o.ledger_seq
              WHERE o.status = 'open' AND to_char(e.entry_date, 'YYYY-MM') = p.period) AS open_objections
     FROM periods p
     WHERE ($1::text IS NULL OR p.period LIKE $1 || '-%')
     ORDER BY p.period DESC`,
    [year ?? null],
  );
  return { items: res.rows };
}

// ---- annual audit sign-off (spec 18.7: clause 3.4 asks for a yearly audit by a non-manager) ------

async function assertYearLocked(db: Db, year: string): Promise<void> {
  const res = await db.query(
    `SELECT count(*)::int AS n FROM periods WHERE period LIKE $1 || '-%' AND locked_at IS NOT NULL`,
    [year],
  );
  if ((res.rows[0] as { n: number }).n !== 12) {
    throw badRequest('year.not_locked', 'All twelve months must be locked first');
  }
}

/** The cashier asks the auditor to sign the year. */
export async function requestAnnualAudit(deps: PeriodDeps, actor: PeriodActor, year: string): Promise<{ id: string }> {
  return inTransaction(deps.pool, async (tx) => {
    await assertYearLocked(tx, year);
    const existing = await tx.query(
      `SELECT status FROM approvals WHERE kind = 'annual_audit' AND ref_id = $1 AND status IN ('pending','approved')`,
      [year],
    );
    if ((existing.rowCount ?? 0) > 0) throw conflict('audit.already_requested', 'An audit sign-off already exists for this year');
    const res = await tx.query(
      `INSERT INTO approvals (kind, ref_id, requested_by, reason) VALUES ('annual_audit', $1, $2, $3) RETURNING id`,
      [year, actor.userId, `Annual audit ${year}`],
    );
    await audit(tx, { actor: actor.userId, action: 'audit.request', entityType: 'year', entityId: year, ip: actor.ip, deviceId: actor.deviceId });
    return { id: (res.rows[0] as { id: string }).id };
  });
}

/** The auditor signs the year. The cashier's own request can never be signed by the cashier. */
export async function signOffAnnualAudit(deps: PeriodDeps, actor: PeriodActor, year: string): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `SELECT id, requested_by FROM approvals WHERE kind = 'annual_audit' AND ref_id = $1 AND status = 'pending' FOR UPDATE`,
      [year],
    );
    const row = res.rows[0] as { id: string; requested_by: string } | undefined;
    if (!row) throw notFound('audit.no_request', 'There is no audit request waiting for this year');
    if (row.requested_by === actor.userId) throw conflict('audit.self_signoff', 'You cannot sign your own request');
    await tx.query(`UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = $3 WHERE id = $1`, [
      row.id,
      actor.userId,
      deps.clock.now(),
    ]);
    await audit(tx, { actor: actor.userId, action: 'audit.signoff', entityType: 'year', entityId: year, ip: actor.ip, deviceId: actor.deviceId });
  });
}

export async function annualAuditStatus(db: Db, year: string) {
  const res = await db.query(
    `SELECT status, decided_at FROM approvals WHERE kind = 'annual_audit' AND ref_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [year],
  );
  const row = res.rows[0] as { status: string; decided_at: Date | null } | undefined;
  return { year, status: row?.status ?? 'none', signed_at: row?.decided_at ?? null };
}

export async function assertReadyForArchive(db: Db, year: string): Promise<void> {
  await assertYearLocked(db, year);
  const signed = await db.query(
    `SELECT 1 FROM approvals WHERE kind = 'annual_audit' AND ref_id = $1 AND status = 'approved'`,
    [year],
  );
  if ((signed.rowCount ?? 0) === 0) {
    throw badRequest('year.not_audited', 'The archive is incomplete without the auditor\'s annual sign-off');
  }
}
