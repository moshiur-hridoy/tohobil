import type pg from 'pg';
import {
  addMonths,
  divRound,
  formatBDT,
  type Clock,
} from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { type Db } from '../lib/tx';
import { toBigInt } from '../lib/money';
import { ruleBool, ruleInt, rulePaisa } from '../lib/rules';
import { type LedgerActor } from '../ledger/service';
import { notifyMember } from '../notifications/service';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import type { Logger } from 'pino';

export interface StatusDeps {
  pool: pg.Pool;
  clock: Clock;
  pushSender: PushSender;
  smsProvider: SmsProvider;
  log?: Logger;
}

interface MemberRow {
  id: string;
  code: string;
  full_name: string;
  status: string;
  phone: string;
}

interface UnpaidPeriod {
  period: string;
}

/**
 * Count consecutive months with any outstanding principal or unwaived fine.
 * Counting starts from the most recent unpaid period and walks backwards until a
 * fully paid period is found. This matches the spec: three consecutive months of
 * unpaid dues/fines does not disappear just because the current month has no due yet.
 */
export async function computeConsecutiveUnpaidMonths(
  db: Db,
  memberId: string,
  today: string,
): Promise<number> {
  const rows = (await db.query(
    `SELECT period FROM (
       SELECT DISTINCT d.period
       FROM v_due_status d
       -- A special contribution is only shown as owed; it never makes a month "unpaid" (ASSUMPTIONS 90).
       WHERE d.member_id = $1 AND d.outstanding_paisa > 0 AND d.kind <> 'special'
       UNION
       SELECT DISTINCT du.period
       FROM v_fine_status f
       JOIN dues du ON du.id = f.due_id
       WHERE f.member_id = $1 AND f.outstanding_paisa > 0
     ) u
     ORDER BY period`,
    [memberId],
  )).rows as UnpaidPeriod[];

  if (rows.length === 0) return 0;

  const unpaid = new Set(rows.map((r) => r.period));
  // Start from the most recent unpaid period (or this period if it is unpaid).
  const currentPeriod = today.slice(0, 7);
  let startPeriod = (rows[rows.length - 1] as UnpaidPeriod).period;
  if (unpaid.has(currentPeriod) && currentPeriod > startPeriod) {
    startPeriod = currentPeriod;
  }

  let count = 0;
  let p = startPeriod;
  while (unpaid.has(p)) {
    count += 1;
    p = addMonths(p, -1);
  }
  return count;
}

/**
 * Insert a member_status_events row and update members.status.
 * Call inside an open transaction; the caller must already hold any needed locks.
 */
export async function transitionMemberStatus(
  db: Db,
  memberId: string,
  fromStatus: string,
  toStatus: string,
  reason: string,
  proposalId?: string | null,
  actorId?: string | null,
): Promise<void> {
  const nowRes = await db.query(`SELECT now()`);
  const now = (nowRes.rows[0] as { now: Date }).now;

  await db.query(
    `INSERT INTO member_status_events (member_id, from_status, to_status, reason, proposal_id, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [memberId, fromStatus, toStatus, reason, proposalId ?? null, actorId ?? null, now],
  );

  await db.query(`UPDATE members SET status = $2 WHERE id = $1`, [memberId, toStatus]);
}

interface MemberFinancials {
  shares: number;
  sharesOutstanding: number;
  netAssets: bigint;
  navPerShare: bigint;
  capital: bigint;
  outstandingPrincipal: bigint;
  outstandingFines: bigint;
  escrow: bigint;
}

/**
 * Compute financials needed for snapshots and settlements. Assets without a valuation use cost.
 * Acquiring assets are counted at the cost recorded so far. sold assets are ignored.
 */
export async function computeMemberFinancials(
  db: Db,
  memberId: string,
  today: string,
): Promise<MemberFinancials> {
  // cash and deduction account balances
  const acctRows = (await db.query(
    `SELECT code, natural_balance_paisa FROM v_account_balances
     WHERE code IN ('CASH','BANK','BKASH','NAGAD','SETTLEMENT_PAYABLE','MEMBER_ESCROW','CHARITY_PAYABLE','LEVY_CLEARING','INACTIVE_HELD','MEMBER_QARD','DEFERRED_PURCHASE_PAYABLE')`,
  )).rows as Array<{ code: string; natural_balance_paisa: string | number | bigint }>;
  const acct = (code: string) => toBigInt(acctRows.find((r) => r.code === code)?.natural_balance_paisa ?? 0);
  const cash = acct('CASH') + acct('BANK') + acct('BKASH') + acct('NAGAD');
  const deductions =
    acct('SETTLEMENT_PAYABLE') +
    acct('MEMBER_ESCROW') +
    acct('CHARITY_PAYABLE') +
    acct('LEVY_CLEARING') +
    acct('INACTIVE_HELD') +
    acct('MEMBER_QARD') +
    acct('DEFERRED_PURCHASE_PAYABLE');

  // asset valuations
  const assetRows = (await db.query(
    `SELECT a.status, a.cost_paisa,
            (SELECT value_paisa FROM asset_valuations WHERE asset_id = a.id ORDER BY as_of DESC LIMIT 1) AS value_paisa
     FROM assets a
     WHERE a.status IN ('held','acquiring')`,
  )).rows as Array<{
    status: string;
    cost_paisa: string | number | bigint;
    value_paisa: string | number | bigint | null;
  }>;
  const assetValue = assetRows.reduce((sum, a) => {
    const value = a.value_paisa != null ? toBigInt(a.value_paisa) : toBigInt(a.cost_paisa);
    return sum + value;
  }, 0n);

  // member capital and outstanding
  const capitalRow = (await db.query(
    `SELECT COALESCE(capital_paisa, 0) AS capital_paisa FROM v_member_balances WHERE member_id = $1`,
    [memberId],
  )).rows[0] as { capital_paisa: string | number | bigint } | undefined;
  const capital = toBigInt(capitalRow?.capital_paisa ?? 0);

  const dueRow = (await db.query(
    `SELECT COALESCE(SUM(GREATEST(outstanding_paisa, 0)), 0) AS p FROM v_due_status WHERE member_id = $1`,
    [memberId],
  )).rows[0] as { p: string | number | bigint } | undefined;
  const outstandingPrincipal = toBigInt(dueRow?.p ?? 0);

  const fineRow = (await db.query(
    `SELECT COALESCE(SUM(GREATEST(outstanding_paisa, 0)), 0) AS f FROM v_fine_status WHERE member_id = $1`,
    [memberId],
  )).rows[0] as { f: string | number | bigint } | undefined;
  const outstandingFines = toBigInt(fineRow?.f ?? 0);

  // escrow (credit = liability)
  const escrowRow = (await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN credit_account = 'MEMBER_ESCROW' AND member_id = $1 THEN amount_paisa ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN debit_account = 'MEMBER_ESCROW' AND member_id = $1 THEN amount_paisa ELSE 0 END), 0)
       AS escrow_paisa
     FROM ledger_entries`,
    [memberId],
  )).rows[0] as { escrow_paisa: string | number | bigint } | undefined;
  const escrow = toBigInt(escrowRow?.escrow_paisa ?? 0);

  // shares
  const sharesRow = (await db.query(`SELECT shares_on($1, $2::date) AS shares`, [memberId, today]))
    .rows[0] as { shares: number } | undefined;
  const shares = sharesRow?.shares ?? 0;

  const soRow = (await db.query(
    `SELECT COALESCE(SUM(shares_on(m.id, $1::date)), 0)::int AS so
     FROM members m
     WHERE m.status IN ('active','warning','suspended','deceased')`,
    [today],
  )).rows[0] as { so: number } | undefined;
  const sharesOutstanding = soRow?.so ?? 0;

  const netAssets = cash + assetValue - deductions;
  const navPerShare = sharesOutstanding > 0 ? divRound(netAssets, BigInt(sharesOutstanding)) : 0n;

  return {
    shares,
    sharesOutstanding,
    netAssets,
    navPerShare,
    capital,
    outstandingPrincipal,
    outstandingFines,
    escrow,
  };
}

/** Create a locked member snapshot (kind='suspension' or 'settlement_quote'). */
export async function createMemberSnapshot(
  db: Db,
  input: {
    memberId: string;
    kind: 'suspension' | 'settlement_quote';
    today: string;
    fin: MemberFinancials;
    proposalId?: string | null;
    gross?: bigint;
    escrow?: bigint;
    deductions?: Record<string, bigint>;
    net?: bigint;
  },
): Promise<string> {
  const { memberId, kind, today, fin, proposalId, gross, escrow, deductions, net } = input;
  const snap = await db.query(
    `INSERT INTO member_snapshots
       (member_id, kind, taken_on, shares, net_assets_paisa, shares_outstanding, nav_per_share_paisa,
        paid_in_capital_paisa, gross_paisa, escrow_paisa, deductions, net_paisa, proposal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      memberId,
      kind,
      today,
      fin.shares,
      fin.netAssets.toString(),
      fin.sharesOutstanding,
      fin.navPerShare.toString(),
      fin.capital.toString(),
      gross?.toString() ?? null,
      escrow?.toString() ?? null,
      JSON.stringify(
        Object.fromEntries(Object.entries(deductions ?? {}).map(([k, v]) => [k, v.toString()])),
      ),
      net?.toString() ?? null,
      proposalId ?? null,
    ],
  );
  return (snap.rows[0] as { id: string }).id;
}

/**
 * Suspend a member: status -> suspended, record suspension_on, write a suspension snapshot
 * and audit the change. Existing dues and fines stay open; new ones stop because the
 * generators only target active/warning members.
 */
export async function suspendMember(
  db: Db,
  deps: StatusDeps,
  memberId: string,
  proposalId?: string | null,
  actorId?: string | null,
  reason = 'Membership suspended due to arrears',
): Promise<void> {
  const today = deps.clock.todayDhaka();
  const member = (await db.query(
    `SELECT id, code, full_name, status, phone FROM members WHERE id = $1 FOR UPDATE`,
    [memberId],
  )).rows[0] as MemberRow | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');

  await transitionMemberStatus(db, memberId, member.status, 'suspended', reason, proposalId, actorId);
  await db.query(`UPDATE members SET suspended_on = $2 WHERE id = $1`, [memberId, today]);

  const fin = await computeMemberFinancials(db, memberId, today);
  const snapshotId = await createMemberSnapshot(db, {
    memberId,
    kind: 'suspension',
    today,
    fin,
    proposalId,
    deductions: {
      outstanding_principal_paisa: fin.outstandingPrincipal,
      outstanding_fines_paisa: fin.outstandingFines,
      escrow_paisa: fin.escrow,
    },
  });

  await notifyMember(
    { pool: deps.pool, clock: deps.clock, log: deps.log!, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
    db,
    {
      memberId,
      template: 'suspension_notice',
      vars: { name: member.full_name, date: today },
      actor: undefined,
    },
  );

  await audit(db, {
    actor: actorId ?? null,
    action: proposalId ? 'member.suspend' : 'system.suspension',
    entityType: 'member',
    entityId: memberId,
    before: { status: member.status },
    after: { status: 'suspended', snapshot_id: snapshotId, proposal_id: proposalId ?? null },
    ip: undefined,
    deviceId: null,
  });
}

interface NewDue {
  due_id: string;
  due_date: string;
  amount_paisa: bigint;
}

/**
 * Generate a single catch-up due for one member in one past period, using the rule in force
 * for that period. Returns the created/found due and a flag indicating whether it was newly created.
 */
async function generateCatchUpDueForMember(
  db: Db,
  deps: StatusDeps,
  memberId: string,
  period: string,
): Promise<{ due: NewDue; created: boolean }> {
  const first = `${period}-01`;
  const dueDay = await ruleInt(db, 'due_day', first);
  const dateRes = await db.query(
    `SELECT GREATEST(LEAST($1::date, (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date),
                     date_trunc('month', $1::date)::date)::text AS due_date`,
    [`${period}-${String(dueDay).padStart(2, '0')}`],
  );
  const dueDate = (dateRes.rows[0] as { due_date: string }).due_date;

  const perShare = await rulePaisa(db, 'monthly_due_per_share_paisa', first);
  const shares = (await db.query(`SELECT shares_on($1, $2::date) AS shares`, [memberId, first]))
    .rows[0] as { shares: number } | undefined;
  if (!shares || shares.shares === 0) {
    return { due: { due_id: '', due_date: dueDate, amount_paisa: 0n }, created: false };
  }

  const amount = BigInt(shares.shares) * perShare;
  const insert = await db.query(
    `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
     VALUES ($1::uuid, $2, 'monthly', $3, $4, $5)
     ON CONFLICT (member_id, period, kind) WHERE kind <> 'entry' DO NOTHING
     RETURNING id`,
    [memberId, period, shares.shares, amount.toString(), dueDate],
  );
  const dueId = (insert.rows[0] as { id: string } | undefined)?.id;

  if (dueId) {
    await db.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [period]);
  }

  if (dueId) {
    return { due: { due_id: dueId, due_date: dueDate, amount_paisa: amount }, created: true };
  }

  const found = (await db.query(
    `SELECT id, due_date::text AS due_date, amount_paisa::text AS amount_paisa
     FROM dues WHERE member_id = $1 AND period = $2 AND kind = 'monthly'`,
    [memberId, period],
  )).rows[0] as { id: string; due_date: string; amount_paisa: string } | undefined;

  if (!found) {
    return { due: { due_id: '', due_date: dueDate, amount_paisa: amount }, created: false };
  }

  return {
    due: { due_id: found.id, due_date: found.due_date, amount_paisa: toBigInt(found.amount_paisa) },
    created: false,
  };
}

/**
 * Spend unallocated confirmed payments for this member on the newly created dues,
 * oldest payment first, oldest due first.
 */
async function applyMemberCredit(
  db: Db,
  memberId: string,
  newDues: NewDue[],
): Promise<bigint> {
  const res = await db.query(
    `SELECT id, unallocated_paisa FROM payments
     WHERE member_id = $1 AND status = 'confirmed' AND unallocated_paisa > 0
     ORDER BY confirmed_at, id
     FOR UPDATE`,
    [memberId],
  );
  const credits = (res.rows as Array<{ id: string; unallocated_paisa: string | number | bigint }>).map(
    (r) => ({ id: r.id, left: toBigInt(r.unallocated_paisa) }),
  );
  if (credits.length === 0 || newDues.length === 0) return 0n;

  let applied = 0n;
  for (const due of [...newDues].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
    if (due.amount_paisa === 0n) continue;
    let need = due.amount_paisa;
    for (const credit of credits) {
      if (need === 0n) break;
      const take = credit.left < need ? credit.left : need;
      if (take === 0n) continue;
      await db.query(
        `INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1,$2,$3)`,
        [credit.id, due.due_id, take.toString()],
      );
      await db.query(
        `UPDATE payments SET unallocated_paisa = unallocated_paisa - $2 WHERE id = $1`,
        [credit.id, take.toString()],
      );
      credit.left -= take;
      need -= take;
      applied += take;
    }
  }
  return applied;
}

/**
 * Re-instate a suspended member. Catch-up dues are generated for every period after
 * suspended_on up to the current period using the per-period rule. Fines are only charged
 * when reinstatement_charges_fines is true.
 */
export async function reinstateMember(
  db: Db,
  deps: StatusDeps,
  memberId: string,
  proposalId?: string | null,
  actorId?: string | null,
  reason = 'Membership reinstated',
): Promise<void> {
  const today = deps.clock.todayDhaka();
  const member = (await db.query(
    `SELECT id, code, full_name, status, phone, suspended_on FROM members WHERE id = $1 FOR UPDATE`,
    [memberId],
  )).rows[0] as (MemberRow & { suspended_on: string | null }) | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');
  if (member.status !== 'suspended') {
    throw badRequest('member.not_suspended', 'Only suspended members can be reinstated');
  }

  await transitionMemberStatus(db, memberId, 'suspended', 'active', reason, proposalId, actorId);
  await db.query(`UPDATE members SET suspended_on = NULL WHERE id = $1`, [memberId]);

  const suspendedOn = member.suspended_on ?? today;
  const firstCatchUp = addMonths(suspendedOn.slice(0, 7), 1);
  const current = today.slice(0, 7);

  const newDues: NewDue[] = [];
  let period = firstCatchUp;
  while (period <= current) {
    const { due, created } = await generateCatchUpDueForMember(db, deps, memberId, period);
    if (created && due.due_id) newDues.push(due);
    period = addMonths(period, 1);
  }

  if (newDues.length > 0) {
    await applyMemberCredit(db, memberId, newDues);
  }

  const ruleAsOf = `${today.slice(0, 7)}-01`;
  const chargeFines = await ruleBool(db, 'reinstatement_charges_fines', ruleAsOf);
  if (chargeFines) {
    for (const due of newDues) {
      if (due.amount_paisa === 0n || !due.due_id) continue;
      const sharesRow = (await db.query(`SELECT shares_snapshot FROM dues WHERE id = $1`, [due.due_id]))
        .rows[0] as { shares_snapshot: number } | undefined;
      const shares = sharesRow?.shares_snapshot ?? 0;
      if (shares === 0) continue;
      const finePerShare = await rulePaisa(
        db,
        'fine_per_share_paisa',
        due.due_date.slice(0, 10),
      );
      const fineAmount = BigInt(shares) * finePerShare;
      if (fineAmount <= 0n) continue;
      await db.query(
        `INSERT INTO fines (due_id, member_id, amount_paisa, kind, reason)
         VALUES ($1::uuid, $2::uuid, $3, 'late_payment', 'reinstatement')
         ON CONFLICT (due_id) DO NOTHING`,
        [due.due_id, memberId, fineAmount.toString()],
      );
    }
  }

  await notifyMember(
    { pool: deps.pool, clock: deps.clock, log: deps.log!, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
    db,
    {
      memberId,
      template: 'reinstatement_notice',
      vars: { name: member.full_name },
      actor: undefined,
    },
  );

  await audit(db, {
    actor: actorId ?? null,
    action: 'member.reinstate',
    entityType: 'member',
    entityId: memberId,
    before: { status: 'suspended', suspended_on: suspendedOn },
    after: { status: 'active', catch_up_dues: newDues.length, catch_up_periods: newDues.map((d) => d.due_date.slice(0, 7)) },
    ip: undefined,
    deviceId: null,
  });
}

/** Total outstanding dues and fines for a member. */
async function totalArrears(db: Db, memberId: string): Promise<bigint> {
  const [d, f] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(GREATEST(outstanding_paisa, 0)), 0) AS p FROM v_due_status WHERE member_id = $1`,
      [memberId],
    ),
    db.query(
      `SELECT COALESCE(SUM(GREATEST(outstanding_paisa, 0)), 0) AS f FROM v_fine_status WHERE member_id = $1`,
      [memberId],
    ),
  ]);
  return toBigInt((d.rows[0] as { p: string | number | bigint }).p) + toBigInt((f.rows[0] as { f: string | number | bigint }).f);
}

/**
 * Queue a final notice to a member with 3+ consecutive unpaid months. The notice ignores
 * SMS opt-out and carries the deadline and total arrears.
 */
export async function issueFinalNotice(
  db: Db,
  deps: StatusDeps,
  memberId: string,
): Promise<void> {
  const today = deps.clock.todayDhaka();
  const member = (await db.query(`SELECT full_name, phone FROM members WHERE id = $1`, [memberId]))
    .rows[0] as MemberRow | undefined;
  if (!member) return;
  const finalNoticeDays = await ruleInt(db, 'final_notice_days', `${today.slice(0, 7)}-01`);
  const arrears = await totalArrears(db, memberId);

  await notifyMember(
    { pool: deps.pool, clock: deps.clock, log: deps.log!, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
    db,
    {
      memberId,
      template: 'final_notice',
      vars: {
        name: member.full_name,
        days: String(finalNoticeDays),
        total: formatBDT(arrears, { digits: 'bn' }),
      },
      actor: undefined,
      dedupeLabel: today,
    },
  );
}

interface ActorInfo {
  userId: string;
  ip?: string;
  deviceId?: string | null;
}

/** Build a LedgerActor from an optional actor plus a system fallback. */
function ledgerActor(actor?: ActorInfo | null): LedgerActor {
  return { userId: actor?.userId ?? null, ip: actor?.ip, deviceId: actor?.deviceId ?? null };
}

export { ledgerActor };
