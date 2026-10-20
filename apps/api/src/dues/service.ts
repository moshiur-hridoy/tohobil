import type pg from 'pg';
import { dateInPeriod, periodStart, type Clock, type DueKind } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest } from '../lib/errors';
import { toBigInt } from '../lib/money';
import { fundTerm, ruleInt, rulePaisa } from '../lib/rules';
import { inTransaction } from '../lib/tx';

/** Kinds this generator creates. `entry` and `levy` dues come from proposals (Phases 3 and 4). */
export type GeneratedDueKind = Extract<DueKind, 'monthly' | 'start_boost'>;

export interface GenerateDuesInput {
  /** `YYYY-MM`. Past periods are allowed (backfill); a future period is rejected. */
  period: string;
  /** Default `['monthly']`. `start_boost` is the one-time legacy due and is only ever asked for explicitly. */
  kinds?: readonly GeneratedDueKind[];
  /** The user who triggered it; `null` for the scheduled job and the CLI. */
  actor?: string | null;
}

export interface GeneratedDue {
  due_id: string;
  member_id: string;
  member_code: string;
  kind: GeneratedDueKind;
  shares: number;
  amount_paisa: bigint;
  due_date: string;
}

export interface GenerateDuesResult {
  period: string;
  created: GeneratedDue[];
  /** Dues that were already there (or, for `start_boost`, already issued in another period). */
  already_existed: number;
  /** Set when nothing was generated because the period starts after the fund's term ends. */
  skipped: 'after_fund_term' | null;
  /** Unallocated member credit that was applied to the new dues. */
  credit_applied_paisa: bigint;
}

export interface DuesDeps {
  pool: pg.Pool;
  clock: Clock;
}

const DEFAULT_KINDS: readonly GeneratedDueKind[] = ['monthly'];

/**
 * Generate the dues of one period (spec 5.3). Idempotent: running it twice creates nothing the second
 * time. Everything happens in one transaction.
 *
 *  - Who: members with status `active` or `warning` and more than 0 shares on the period's first day.
 *    Suspended, exited, inactive and prospective members get nothing.
 *  - How much: `shares_on(first day) * rule(first day)`. The shares and the rule are read as of the
 *    period's first day, so a holding or rule change made later in the month never rewrites a due.
 *  - When due: the `due_day` rule (clamped to the month length) in that period.
 *  - After the fund's term ends (`fund_term_end`) nothing is generated (constitution 1.2).
 *  - Unallocated credit from confirmed payments is applied to the new dues, oldest payment first.
 */
export async function generateDues(
  deps: DuesDeps,
  input: GenerateDuesInput,
): Promise<GenerateDuesResult> {
  const { period } = input;
  const kinds = [...new Set(input.kinds ?? DEFAULT_KINDS)];
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw badRequest('dues.invalid_period', 'Period must look like 2026-11');
  }
  if (period > deps.clock.todayDhaka().slice(0, 7)) {
    throw badRequest('dues.period_in_future', 'Dues cannot be generated for a future period');
  }

  const first = periodStart(period);

  return inTransaction(deps.pool, async (tx): Promise<GenerateDuesResult> => {
    const term = await fundTerm(tx, first);
    if (term.end !== null && first > term.end) {
      return {
        period,
        created: [],
        already_existed: 0,
        skipped: 'after_fund_term',
        credit_applied_paisa: 0n,
      };
    }

    const dueDay = await ruleInt(tx, 'due_day', first);
    const dueDate = dateInPeriod(period, dueDay);

    const eligible = await tx.query(
      `SELECT m.id, m.code, shares_on(m.id, $1::date) AS shares
       FROM members m
       WHERE m.status IN ('active','warning') AND shares_on(m.id, $1::date) > 0
       ORDER BY m.code`,
      [first],
    );
    const members = eligible.rows as Array<{ id: string; code: string; shares: number }>;

    const created: GeneratedDue[] = [];
    let existing = 0;
    for (const kind of kinds) {
      const perShare = await rulePaisa(
        tx,
        kind === 'monthly' ? 'monthly_due_per_share_paisa' : 'start_boost_per_share_paisa',
        first,
      );
      for (const m of members) {
        const amount = BigInt(m.shares) * perShare;
        // start_boost is one-time per member: skip anyone who already has one, in any period.
        const res = await tx.query(
          `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
           SELECT $1::uuid, $2::text, $3::text, $4::int, $5::bigint, $6::date
           WHERE $3::text <> 'start_boost'
              OR NOT EXISTS (SELECT 1 FROM dues WHERE member_id = $1::uuid AND kind = 'start_boost')
           ON CONFLICT (member_id, period, kind) DO NOTHING
           RETURNING id`,
          [m.id, period, kind, m.shares, amount.toString(), dueDate],
        );
        const row = res.rows[0] as { id: string } | undefined;
        if (row) {
          created.push({
            due_id: row.id,
            member_id: m.id,
            member_code: m.code,
            kind,
            shares: m.shares,
            amount_paisa: amount,
            due_date: dueDate,
          });
        } else {
          existing += 1;
        }
      }
    }

    let creditApplied = 0n;
    if (created.length > 0) {
      await tx.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [period]);
      for (const memberId of new Set(created.map((c) => c.member_id))) {
        creditApplied += await applyCredit(
          tx,
          memberId,
          created.filter((c) => c.member_id === memberId),
        );
      }
      await audit(tx, {
        actor: input.actor ?? null,
        action: 'dues.generate',
        entityType: 'period',
        entityId: period,
        after: {
          kinds,
          created: created.length,
          already_existed: existing,
          credit_applied_paisa: creditApplied.toString(),
        },
      });
    }

    return {
      period,
      created,
      already_existed: existing,
      skipped: null,
      credit_applied_paisa: creditApplied,
    };
  });
}

/**
 * Spend a member's unallocated credit (spec 5.3) on dues that were just created, oldest payment first.
 * The credit was already posted to MEMBER_CAPITAL when its payment was confirmed, so this writes only
 * allocation rows and lowers `payments.unallocated_paisa`: no ledger entry.
 */
async function applyCredit(
  tx: pg.PoolClient,
  memberId: string,
  newDues: readonly GeneratedDue[],
): Promise<bigint> {
  const res = await tx.query(
    `SELECT id, unallocated_paisa FROM payments
     WHERE member_id = $1 AND status = 'confirmed' AND unallocated_paisa > 0
     ORDER BY confirmed_at, id
     FOR UPDATE`,
    [memberId],
  );
  const credits = (res.rows as Array<{ id: string; unallocated_paisa: unknown }>).map((r) => ({
    id: r.id,
    left: toBigInt(r.unallocated_paisa),
  }));
  if (credits.length === 0) return 0n;

  let applied = 0n;
  for (const due of [...newDues].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
    let need = due.amount_paisa;
    for (const credit of credits) {
      if (need === 0n) break;
      const take = credit.left < need ? credit.left : need;
      if (take === 0n) continue;
      await tx.query(
        `INSERT INTO payment_allocations (payment_id, due_id, amount_paisa) VALUES ($1,$2,$3)`,
        [credit.id, due.due_id, take.toString()],
      );
      await tx.query(
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
