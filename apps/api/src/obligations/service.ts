import type pg from 'pg';
import type { Clock, FinancingPay, LevyRemit } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { accountBalance } from '../lib/nav';
import { toBigInt } from '../lib/money';
import { inTransaction } from '../lib/tx';
import { postEntries, type LedgerActor } from '../ledger/service';

export interface ObligationDeps {
  pool: pg.Pool;
  clock: Clock;
}

/** Collected levy money still held for the registrar, and what has already been handed over. */
export async function levySummary(pool: pg.Pool) {
  const held = await accountBalance(pool, 'LEVY_CLEARING');
  const remitted = await pool.query(
    `SELECT seq::text, entry_date::text AS entry_date, amount_paisa::text AS amount_paisa, memo
     FROM ledger_entries WHERE ref_type = 'levy_remittance' AND reverses_seq IS NULL
     ORDER BY seq DESC LIMIT 50`,
  );
  const dues = await pool.query(
    `SELECT period, count(*)::int AS members, sum(amount_paisa)::text AS total_paisa,
            sum(amount_paisa - allocated_paisa)::text AS outstanding_paisa
     FROM v_due_status WHERE kind = 'levy' GROUP BY period ORDER BY period DESC`,
  );
  return { held_paisa: held.toString(), remittances: remitted.rows, levies: dues.rows };
}

/** Each special contribution (1.4) with what every member owes and has paid towards it, newest first. */
export async function specialSummary(pool: pg.Pool) {
  const rows = (
    await pool.query(
      `SELECT v.period, v.due_date::text AS due_date, m.code, m.full_name, v.shares_snapshot AS shares,
              v.amount_paisa::text AS amount_paisa, v.allocated_paisa::text AS paid_paisa,
              v.outstanding_paisa::text AS outstanding_paisa, v.status
       FROM v_due_status v JOIN members m ON m.id = v.member_id
       WHERE v.kind = 'special'
       ORDER BY v.period DESC, m.code`,
    )
  ).rows as Array<{
    period: string; due_date: string; code: string; full_name: string; shares: number;
    amount_paisa: string; paid_paisa: string; outstanding_paisa: string; status: string;
  }>;
  // The reason is on the proposal that created the dues; its due date names the month.
  const reasons = (
    await pool.query(
      `SELECT substr(payload->>'due_date', 1, 7) AS period, payload->>'reason' AS reason
       FROM proposals WHERE type = 'special_contribution' AND status = 'executed'`,
    )
  ).rows as Array<{ period: string; reason: string }>;
  const reasonOf = new Map(reasons.map((r) => [r.period, r.reason]));

  const items = new Map<string, { period: string; due_date: string; reason: string | null; total: bigint; outstanding: bigint; members: typeof rows }>();
  for (const r of rows) {
    const item = items.get(r.period) ?? { period: r.period, due_date: r.due_date, reason: reasonOf.get(r.period) ?? null, total: 0n, outstanding: 0n, members: [] };
    item.total += toBigInt(r.amount_paisa);
    const left = toBigInt(r.outstanding_paisa);
    if (left > 0n) item.outstanding += left;
    item.members.push(r);
    items.set(r.period, item);
  }
  return {
    items: [...items.values()].map(({ total, outstanding, ...rest }) => ({
      ...rest,
      total_paisa: total.toString(),
      outstanding_paisa: outstanding.toString(),
    })),
  };
}

export async function remitLevy(
  deps: ObligationDeps,
  actor: LedgerActor,
  input: LevyRemit,
): Promise<{ ledger_seq: string }> {
  return inTransaction(deps.pool, async (tx) => {
    const held = await accountBalance(tx, 'LEVY_CLEARING');
    if (input.amount_paisa > held) {
      throw badRequest('levy.exceeds_held', `Only ${held.toString()} paisa of levy is held`);
    }
    const posted = await postEntries(
      tx as pg.PoolClient,
      [
        {
          entry_date: deps.clock.todayDhaka(),
          debit: 'LEVY_CLEARING',
          credit: input.account,
          amount_paisa: input.amount_paisa,
          member_id: null,
          ref_type: 'levy_remittance',
          ref_id: null,
          memo: `${input.payee}: ${input.note}`,
        },
      ],
      actor,
    );
    return { ledger_seq: posted[0]!.seq.toString() };
  });
}

export async function listFinancing(pool: pg.Pool) {
  const res = await pool.query(
    `SELECT f.id, f.asset_id, a.name AS asset_name, f.counterparty, f.description,
            f.total_paisa::text AS total_paisa, f.created_at,
            coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'due_on', i.due_on::text,
                     'amount_paisa', i.amount_paisa::text, 'paid_at', i.paid_at) ORDER BY i.due_on)
                     FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS instalments
     FROM financing_arrangements f
     JOIN assets a ON a.id = f.asset_id
     LEFT JOIN financing_instalments i ON i.arrangement_id = f.id
     GROUP BY f.id, a.name
     ORDER BY f.created_at DESC`,
  );
  return { items: res.rows };
}

export async function payFinancingInstalment(
  deps: ObligationDeps,
  actor: LedgerActor,
  instalmentId: string,
  input: FinancingPay,
): Promise<{ ledger_seq: string }> {
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `SELECT id, amount_paisa::text AS amount_paisa, paid_at FROM financing_instalments WHERE id = $1 FOR UPDATE`,
      [instalmentId],
    );
    const row = res.rows[0] as { id: string; amount_paisa: string; paid_at: Date | null } | undefined;
    if (!row) throw notFound('financing.instalment_not_found', 'Instalment not found');
    if (row.paid_at) throw conflict('financing.already_paid', 'This instalment has already been paid');
    const posted = await postEntries(
      tx as pg.PoolClient,
      [
        {
          entry_date: deps.clock.todayDhaka(),
          debit: 'DEFERRED_PURCHASE_PAYABLE',
          credit: input.account,
          amount_paisa: toBigInt(row.amount_paisa),
          member_id: null,
          ref_type: 'financing_instalment',
          ref_id: instalmentId,
          memo: 'Deferred purchase instalment',
        },
      ],
      actor,
    );
    const seq = posted[0]!.seq.toString();
    await tx.query(`UPDATE financing_instalments SET paid_at = $2, ledger_seq = $3::bigint WHERE id = $1`, [
      instalmentId,
      deps.clock.now(),
      seq,
    ]);
    await audit(tx, {
      actor: actor.userId,
      action: 'financing.instalment_paid',
      entityType: 'financing_instalment',
      entityId: instalmentId,
      after: { amount_paisa: row.amount_paisa, account: input.account, ledger_seq: seq },
      ip: actor.ip,
      deviceId: actor.deviceId,
    });
    return { ledger_seq: seq };
  });
}
