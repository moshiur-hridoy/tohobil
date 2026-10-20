import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import { audit } from '../lib/audit';
import { rulePaisa } from '../lib/rules';
import { inTransaction } from '../lib/tx';

export interface FineDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface AppliedFine {
  fine_id: string;
  member_id: string;
  member_code: string;
  due_id: string;
  period: string;
  amount_paisa: bigint;
}

/**
 * Apply fines for a specific business date (spec 5.5). Idempotent: only one fine per due.
 * The job calls this on `fine_day` of every month. Fines never compound and only late-payment
 * dues produce fines; absence fines come from meetings (Phase 3).
 */
export async function applyFines(deps: FineDeps, asOf?: string): Promise<AppliedFine[]> {
  const today = asOf ?? deps.clock.todayDhaka();
  return inTransaction(deps.pool, async (tx) => {
    const fineAmount = await rulePaisa(tx, 'fine_per_share_paisa', today);
    const res = await tx.query(
      `SELECT d.id AS due_id, d.member_id, d.period, m.code, shares_on(d.member_id, d.due_date) AS shares
       FROM dues d
       JOIN members m ON m.id = d.member_id
       WHERE d.kind = 'monthly'
         AND d.due_date < $1::date
         AND m.status IN ('active','warning')
         AND NOT EXISTS (
           SELECT 1 FROM fines f
           WHERE f.due_id = d.id AND f.kind = 'late_payment'
         )
         AND d.amount_paisa > COALESCE(
           (SELECT SUM(amount_paisa) FROM payment_allocations WHERE due_id = d.id),
           0
         )`,
      [today],
    );
    const rows = res.rows as Array<{
      due_id: string;
      member_id: string;
      period: string;
      code: string;
      shares: number;
    }>;
    const created: AppliedFine[] = [];
    for (const row of rows) {
      const amount = BigInt(row.shares) * fineAmount;
      if (amount <= 0n) continue;
      const insert = await tx.query(
        `INSERT INTO fines (due_id, member_id, amount_paisa, reason)
         VALUES ($1, $2, $3::bigint, 'late_payment')
         ON CONFLICT (due_id) WHERE due_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [row.due_id, row.member_id, amount.toString()],
      );
      const fineId = (insert.rows[0] as { id: string } | undefined)?.id;
      if (fineId) {
        created.push({
          fine_id: fineId,
          member_id: row.member_id,
          member_code: row.code,
          due_id: row.due_id,
          period: row.period,
          amount_paisa: amount,
        });
      }
    }
    if (created.length > 0) {
      await audit(tx, {
        actor: null,
        action: 'fines.apply',
        entityType: 'date',
        entityId: today,
        after: { count: created.length, total_paisa: created.reduce((s, c) => s + c.amount_paisa, 0n).toString() },
      });
    }
    return created;
  });
}
