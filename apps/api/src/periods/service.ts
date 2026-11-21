import type pg from 'pg';
import { periodEnd, periodStart, type Clock, type ReconciliationSubmit } from '@barakah/shared';
import { audit } from '../lib/audit';
import { getRule } from '../lib/rules';
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

/**
 * What one month's check needs (ASSUMPTIONS 132). With one cash pool (ASSUMPTIONS 96) a single `BANK`
 * row stands for cash, bank, bKash and Nagad together; with `cash_tracking_by_method` on, one row per
 * account. Every shop that had money sent to it that month, or a standing approval covering it, needs
 * its statement figure. The books' figures are computed here, never supplied.
 */
export interface MonthRequirements {
  mode: 'pool' | 'per_method';
  accounts: Array<{ account: string; books_paisa: bigint }>;
  shops: Array<{ partner_id: string; name: string; sent_paisa: bigint; purchases: number }>;
}

/** Money sent to each shop in the month: purchases (`DR INVESTMENTS_AT_COST`) net of their reversals. */
async function sentToShops(db: Db, period: string): Promise<Map<string, { sent: bigint; purchases: number }>> {
  const res = await db.query(
    `SELECT a.partner_id,
            SUM(CASE WHEN l.debit_account = 'INVESTMENTS_AT_COST' THEN l.amount_paisa ELSE -l.amount_paisa END)::text AS sent,
            count(*) FILTER (WHERE l.debit_account = 'INVESTMENTS_AT_COST' AND l.reverses_seq IS NULL)::int AS purchases
     FROM ledger_entries l
     JOIN assets a ON a.id = l.ref_id
       OR (l.ref_type IN ('proposal', 'proposal_reversal') AND a.proposal_id = l.ref_id AND a.mandate_id IS NULL)
     WHERE a.partner_id IS NOT NULL
       AND l.entry_date BETWEEN $1::date AND $2::date
       AND (l.debit_account = 'INVESTMENTS_AT_COST' OR (l.credit_account = 'INVESTMENTS_AT_COST' AND l.reverses_seq IS NOT NULL))
     GROUP BY a.partner_id`,
    [periodStart(period), periodEnd(period)],
  );
  return new Map((res.rows as Array<{ partner_id: string; sent: string; purchases: number }>).map((r) => [r.partner_id, { sent: toBigInt(r.sent), purchases: r.purchases }]));
}

export async function monthRequirements(db: Db, period: string): Promise<MonthRequirements> {
  const perMethod = (await getRule(db, 'cash_tracking_by_method', periodEnd(period)))?.value === true;
  const books = await systemBalances(db, period);
  const accounts = perMethod
    ? CASH_ACCOUNTS.map((account) => ({ account, books_paisa: books[account] ?? 0n }))
    : [{ account: 'BANK', books_paisa: CASH_ACCOUNTS.reduce((sum, a) => sum + (books[a] ?? 0n), 0n) }];

  const sent = await sentToShops(db, period);
  const covered = await db.query(
    `SELECT DISTINCT partner_id FROM investment_mandates
     WHERE $1 BETWEEN first_period AND last_period AND (ended_on IS NULL OR ended_on > $2::date)`,
    [period, periodStart(period)],
  );
  const ids = new Set<string>([...sent.keys(), ...(covered.rows as Array<{ partner_id: string }>).map((r) => r.partner_id)]);
  const names = ids.size
    ? (await db.query(`SELECT id, name FROM investment_partners WHERE id = ANY($1::uuid[]) ORDER BY name`, [[...ids]])).rows as Array<{ id: string; name: string }>
    : [];
  return {
    mode: perMethod ? 'per_method' : 'pool',
    accounts,
    shops: names.map((p) => ({ partner_id: p.id, name: p.name, sent_paisa: sent.get(p.id)?.sent ?? 0n, purchases: sent.get(p.id)?.purchases ?? 0 })),
  };
}

/** The pool's money in and out during the month, grouped by what it was for, with the opening and closing figures. */
export async function monthSummary(db: Db, period: string): Promise<{ opening_paisa: string; closing_paisa: string; lines: Array<{ key: string; amount_paisa: string }> }> {
  const cash = [...CASH_ACCOUNTS];
  const balanceAt = async (date: string) =>
    toBigInt(((await db.query(
      `SELECT COALESCE(SUM(CASE WHEN debit_account = ANY($2::text[]) THEN amount_paisa ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN credit_account = ANY($2::text[]) THEN amount_paisa ELSE 0 END), 0) AS b
       FROM ledger_entries WHERE entry_date <= $1::date`,
      [date, cash],
    )).rows[0] as { b: string }).b);
  const dayBefore = (await db.query(`SELECT ($1::date - 1)::text AS d`, [periodStart(period)])).rows[0] as { d: string };
  const opening = await balanceAt(dayBefore.d);
  const closing = await balanceAt(periodEnd(period));
  // Each entry with exactly one side in the pool moves money in (+) or out (-); the other side says why.
  const res = await db.query(
    `SELECT CASE WHEN debit_account = ANY($3::text[]) THEN credit_account ELSE debit_account END AS other,
            SUM(CASE WHEN debit_account = ANY($3::text[]) THEN amount_paisa ELSE -amount_paisa END)::text AS net
     FROM ledger_entries
     WHERE entry_date BETWEEN $1::date AND $2::date
       AND (debit_account = ANY($3::text[])) <> (credit_account = ANY($3::text[]))
     GROUP BY 1`,
    [periodStart(period), periodEnd(period), cash],
  );
  const totals = new Map<string, bigint>();
  for (const r of res.rows as Array<{ other: string; net: string }>) {
    const key = SUMMARY_GROUP[r.other] ?? 'other';
    totals.set(key, (totals.get(key) ?? 0n) + toBigInt(r.net));
  }
  return {
    opening_paisa: opening.toString(),
    closing_paisa: closing.toString(),
    lines: SUMMARY_ORDER.filter((k) => (totals.get(k) ?? 0n) !== 0n).map((key) => ({ key, amount_paisa: totals.get(key)!.toString() })),
  };
}

const SUMMARY_ORDER = ['deposits', 'levy', 'income', 'charity', 'investments', 'costs', 'payouts', 'financing', 'other'] as const;
const SUMMARY_GROUP: Record<string, (typeof SUMMARY_ORDER)[number]> = {
  MEMBER_CAPITAL: 'deposits',
  LEVY_CLEARING: 'levy',
  CHARITY_PAYABLE: 'charity',
  INVESTMENTS_AT_COST: 'investments',
  ASSET_GAIN: 'investments',
  ASSET_LOSS: 'investments',
  RENT_INCOME: 'income',
  BANK_PROFIT: 'income',
  OTHER_INCOME: 'income',
  EXIT_FEE_INCOME: 'income',
  FINE_INCOME: 'income',
  BANK_CHARGE: 'costs',
  SMS_CHARGE: 'costs',
  MAINTENANCE: 'costs',
  OTHER_EXPENSE: 'costs',
  SETTLEMENT_PAYABLE: 'payouts',
  MEMBER_ESCROW: 'payouts',
  DISTRIBUTIONS: 'payouts',
  INACTIVE_HELD: 'payouts',
  MEMBER_QARD: 'financing',
  DEFERRED_PURCHASE_PAYABLE: 'financing',
};

function assertEnded(deps: PeriodDeps, period: string): void {
  if (periodEnd(period) > deps.clock.todayDhaka()) {
    throw badRequest('period.not_ended', 'A month can only be reconciled once its last day has come');
  }
}

async function assertFiles(tx: Db, ids: Array<string | undefined>): Promise<void> {
  const wanted = ids.filter((x): x is string => !!x);
  if (wanted.length === 0) return;
  const res = await tx.query(`SELECT count(*)::int AS n FROM files WHERE id = ANY($1::uuid[])`, [wanted]);
  if ((res.rows[0] as { n: number }).n !== new Set(wanted).size) throw notFound('file.not_found', 'File not found');
}

/**
 * The cashier's month-end check (spec 5.12, ASSUMPTIONS 132). The books' figures are computed here,
 * never supplied, so a count can only be compared with the ledger, not tuned to match it. The rows
 * sent must be exactly the ones the month needs. Re-submitting is allowed until the auditor approves.
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

    const need = await monthRequirements(tx, input.period);
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    if (!sameSet(input.entries.map((e) => e.account), need.accounts.map((a) => a.account))) {
      throw badRequest('reconciliation.wrong_accounts', 'Count exactly the accounts this month needs', { accounts: need.accounts.map((a) => a.account) });
    }
    if (!sameSet(input.shops.map((s) => s.partner_id), need.shops.map((s) => s.partner_id))) {
      throw badRequest('reconciliation.wrong_shops', 'Give the statement figure of exactly the shops this month needs', { shops: need.shops.map((s) => s.partner_id) });
    }
    await assertFiles(tx, [...input.entries.map((e) => e.proof_file_id), ...input.shops.map((s) => s.proof_file_id)]);

    let totalDiff = 0n;
    const mismatches: Array<{ account: string; diff: bigint }> = [];
    for (const row of input.entries) {
      const system = need.accounts.find((a) => a.account === row.account)!.books_paisa;
      const diff = row.actual_balance_paisa - system;
      if (diff !== 0n && !row.note?.trim()) {
        throw badRequest('reconciliation.note_required', `A note is required for ${row.account}: it differs from the books`);
      }
      totalDiff += diff;
      if (diff !== 0n) mismatches.push({ account: row.account, diff });
      await tx.query(
        `INSERT INTO reconciliations (period, account, system_balance_paisa, actual_balance_paisa, note, proof_file_id, submitted_by)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7)
         ON CONFLICT (period, account) DO UPDATE
           SET system_balance_paisa = EXCLUDED.system_balance_paisa,
               actual_balance_paisa = EXCLUDED.actual_balance_paisa,
               note = EXCLUDED.note, proof_file_id = EXCLUDED.proof_file_id, submitted_by = EXCLUDED.submitted_by`,
        [input.period, row.account, system.toString(), row.actual_balance_paisa.toString(), row.note?.trim() || null, row.proof_file_id ?? null, actor.userId],
      );
    }
    for (const row of input.shops) {
      const shop = need.shops.find((s) => s.partner_id === row.partner_id)!;
      const diff = row.statement_paisa - shop.sent_paisa;
      if (diff !== 0n && !row.note?.trim()) {
        throw badRequest('reconciliation.note_required', `A note is required for ${shop.name}: it differs from the books`);
      }
      if (diff !== 0n) mismatches.push({ account: shop.name, diff });
      await tx.query(
        `INSERT INTO reconciliation_shops (period, partner_id, system_sent_paisa, statement_paisa, note, proof_file_id, submitted_by)
         VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7)
         ON CONFLICT (period, partner_id) DO UPDATE
           SET system_sent_paisa = EXCLUDED.system_sent_paisa, statement_paisa = EXCLUDED.statement_paisa,
               note = EXCLUDED.note, proof_file_id = EXCLUDED.proof_file_id, submitted_by = EXCLUDED.submitted_by`,
        [input.period, row.partner_id, shop.sent_paisa.toString(), row.statement_paisa.toString(), row.note?.trim() || null, row.proof_file_id ?? null, actor.userId],
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
      after: { total_difference_paisa: totalDiff.toString(), mismatches: mismatches.length, shops: input.shops.length },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return { period: input.period, difference_paisa: totalDiff.toString() };
  });
}

/**
 * One month for the page: what it needs, what was submitted (with the books' figure then and now, so
 * a later entry dated in the month shows as "books changed"), the money in and out, and the status.
 */
export async function listReconciliations(db: Db, period: string) {
  const need = await monthRequirements(db, period);
  const rows = (await db.query(
    `SELECT account, system_balance_paisa::text AS system_balance_paisa,
            actual_balance_paisa::text AS actual_balance_paisa, difference_paisa::text AS difference_paisa,
            note, proof_file_id, approved_at
     FROM reconciliations WHERE period = $1 ORDER BY account`,
    [period],
  )).rows as Array<Record<string, unknown> & { account: string; system_balance_paisa: string; approved_at: Date | null }>;
  const shopRows = (await db.query(
    `SELECT partner_id, system_sent_paisa::text AS system_sent_paisa, statement_paisa::text AS statement_paisa,
            difference_paisa::text AS difference_paisa, note, proof_file_id, approved_at
     FROM reconciliation_shops WHERE period = $1`,
    [period],
  )).rows as Array<Record<string, unknown> & { partner_id: string; system_sent_paisa: string; approved_at: Date | null }>;
  const accounts = need.accounts.map((a) => {
    const row = rows.find((r) => r.account === a.account) ?? null;
    return { account: a.account, books_paisa: a.books_paisa.toString(), submitted: row, stale: !!row && toBigInt(row.system_balance_paisa) !== a.books_paisa };
  });
  const shops = need.shops.map((s) => {
    const row = shopRows.find((r) => r.partner_id === s.partner_id) ?? null;
    return { partner_id: s.partner_id, name: s.name, sent_paisa: s.sent_paisa.toString(), purchases: s.purchases, submitted: row, stale: !!row && toBigInt(row.system_sent_paisa) !== s.sent_paisa };
  });
  const all = [...accounts, ...shops];
  const counted = all.every((x) => x.submitted);
  const locked = (await db.query(`SELECT locked_at FROM periods WHERE period = $1`, [period])).rows[0] as { locked_at: Date | null } | undefined;
  return {
    period,
    mode: need.mode,
    accounts,
    shops,
    summary: await monthSummary(db, period),
    counted,
    approved: counted && all.every((x) => x.submitted?.approved_at),
    stale: all.some((x) => x.stale),
    locked_at: locked?.locked_at ?? null,
    // the raw rows, as before (reports and the public demo read them)
    items: rows,
  };
}

/**
 * The auditor approves a month's check once every needed row is in. Never their own submission, and
 * never against books that have changed since it was counted (ASSUMPTIONS 132): then it is counted again.
 */
export async function approveReconciliation(deps: PeriodDeps, actor: PeriodActor, period: string): Promise<void> {
  await inTransaction(deps.pool, async (tx) => {
    const rows = (await tx.query(
      `SELECT account, system_balance_paisa::text AS system, approved_at, submitted_by FROM reconciliations WHERE period = $1 FOR UPDATE`,
      [period],
    )).rows as Array<{ account: string; system: string; approved_at: Date | null; submitted_by: string }>;
    const shopRows = (await tx.query(
      `SELECT partner_id, system_sent_paisa::text AS system, approved_at, submitted_by FROM reconciliation_shops WHERE period = $1 FOR UPDATE`,
      [period],
    )).rows as Array<{ partner_id: string; system: string; approved_at: Date | null; submitted_by: string }>;
    const need = await monthRequirements(tx, period);
    const cash = need.accounts.map((a) => ({ need: a.books_paisa, row: rows.find((r) => r.account === a.account) }));
    const shops = need.shops.map((s) => ({ need: s.sent_paisa, row: shopRows.find((r) => r.partner_id === s.partner_id) }));
    const all = [...cash, ...shops];
    if (all.some((x) => !x.row)) {
      throw badRequest('reconciliation.incomplete', 'Every account and shop this month needs must be counted first');
    }
    if (all.every((x) => x.row!.approved_at)) {
      throw conflict('reconciliation.already_approved', 'This month is already approved');
    }
    if (all.some((x) => x.row!.submitted_by === actor.userId)) {
      throw conflict('reconciliation.self_approval', 'You cannot approve your own count');
    }
    if (all.some((x) => toBigInt(x.row!.system) !== x.need)) {
      throw conflict('reconciliation.books_changed', 'The books for this month changed after the count: count again');
    }
    await tx.query(`UPDATE reconciliations SET approved_by = $2, approved_at = $3 WHERE period = $1`, [period, actor.userId, deps.clock.now()]);
    await tx.query(`UPDATE reconciliation_shops SET approved_by = $2, approved_at = $3 WHERE period = $1`, [period, actor.userId, deps.clock.now()]);
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

    // Every row the month needs must be counted and approved (ASSUMPTIONS 132).
    const need = await monthRequirements(tx, period);
    const approvedCash = (await tx.query(
      `SELECT account FROM reconciliations WHERE period = $1 AND approved_at IS NOT NULL`,
      [period],
    )).rows as Array<{ account: string }>;
    const approvedShops = (await tx.query(
      `SELECT partner_id FROM reconciliation_shops WHERE period = $1 AND approved_at IS NOT NULL`,
      [period],
    )).rows as Array<{ partner_id: string }>;
    if (
      !need.accounts.every((a) => approvedCash.some((r) => r.account === a.account)) ||
      !need.shops.every((sh) => approvedShops.some((r) => r.partner_id === sh.partner_id))
    ) {
      throw badRequest('period.not_reconciled', 'The month needs an approved check before it can be locked');
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
