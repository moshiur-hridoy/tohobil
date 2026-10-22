import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { CashAccountCode, Clock, FinancingPay, LevyExpense, LevyExpenseCategory, LevyRemit } from '@barakah/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { accountBalance } from '../lib/nav';
import { toBigInt } from '../lib/money';
import { getRule, requireRule } from '../lib/rules';
import { inTransaction, type Db } from '../lib/tx';
import { postEntries, type LedgerActor } from '../ledger/service';

export interface ObligationDeps {
  pool: pg.Pool;
  clock: Clock;
}

/** Where a levy-fund movement came from or went (the levy fund page lists them newest first). */
export type LevyEntryKind = 'collection' | 'expense' | 'reversal' | 'other';

export interface LevyEntry {
  seq: string;
  entry_date: string;
  direction: 'in' | 'out';
  kind: LevyEntryKind;
  /** For an expense: what it paid for; an old registrar remittance counts as `registration`. */
  category: LevyExpenseCategory | null;
  payee: string | null;
  member_code: string | null;
  member_name: string | null;
  amount_paisa: string;
  memo: string | null;
  receipt_file_id: string | null;
  /** Set when this is an earlier main-fund charge moved onto the levy fund (ASSUMPTIONS 106). */
  moved_from_seq: string | null;
}

/**
 * The levy fund (ASSUMPTIONS 105): what is held (negative when bank charges have run it below
 * zero), what came in and went out, what members still owe on levies, the no-vote limit, and every
 * movement newest first. `remittances` (every expense) and `levies` (dues by month) stay for the
 * screens that already read them.
 */
export async function levySummary(pool: pg.Pool, today: string) {
  const held = await accountBalance(pool, 'LEVY_CLEARING');
  const totals = (
    await pool.query(
      `SELECT COALESCE(SUM(amount_paisa) FILTER (WHERE credit_account = 'LEVY_CLEARING'), 0)::text AS in_paisa,
              COALESCE(SUM(amount_paisa) FILTER (WHERE debit_account = 'LEVY_CLEARING'), 0)::text AS out_paisa
       FROM ledger_entries WHERE 'LEVY_CLEARING' IN (debit_account, credit_account)`,
    )
  ).rows[0] as { in_paisa: string; out_paisa: string };
  const rows = (
    await pool.query(
      `SELECT e.seq::text AS seq, e.entry_date::text AS entry_date, e.debit_account, e.ref_type,
              e.reverses_seq, e.amount_paisa::text AS amount_paisa, e.memo,
              m.code AS member_code, m.full_name AS member_name,
              x.category, x.payee, x.receipt_file_id, x.moved_from_seq::text AS moved_from_seq
       FROM ledger_entries e
       LEFT JOIN members m ON m.id = e.member_id
       LEFT JOIN levy_expenses x ON x.ledger_seq = e.seq
       WHERE 'LEVY_CLEARING' IN (e.debit_account, e.credit_account)
       ORDER BY e.entry_date DESC, e.seq DESC
       LIMIT 300`,
    )
  ).rows as Array<{
    seq: string; entry_date: string; debit_account: string; ref_type: string | null; reverses_seq: unknown;
    amount_paisa: string; memo: string | null; member_code: string | null; member_name: string | null;
    category: LevyExpenseCategory | null; payee: string | null; receipt_file_id: string | null; moved_from_seq: string | null;
  }>;
  const entries: LevyEntry[] = rows.map((r) => {
    const direction = r.debit_account === 'LEVY_CLEARING' ? 'out' : 'in';
    const legacyRemit = r.ref_type === 'levy_remittance';
    const kind: LevyEntryKind = r.reverses_seq !== null ? 'reversal' : r.category || legacyRemit ? 'expense' : direction === 'in' && r.member_code ? 'collection' : 'other';
    return {
      seq: r.seq,
      entry_date: r.entry_date,
      direction,
      kind,
      category: r.category ?? (legacyRemit ? 'registration' : null),
      payee: r.payee,
      member_code: r.member_code,
      member_name: r.member_name,
      amount_paisa: r.amount_paisa,
      memo: r.memo,
      receipt_file_id: r.receipt_file_id,
      moved_from_seq: r.moved_from_seq,
    };
  });
  const dues = await pool.query(
    `SELECT period, count(*)::int AS members, sum(amount_paisa)::text AS total_paisa,
            sum(amount_paisa - allocated_paisa)::text AS outstanding_paisa
     FROM v_due_status WHERE kind = 'levy' GROUP BY period ORDER BY period DESC`,
  );
  const limit = await getRule(pool, LEVY_LIMIT_RULE, today);
  return {
    held_paisa: held.toString(),
    in_paisa: totals.in_paisa,
    out_paisa: totals.out_paisa,
    limit_paisa: limit ? toBigInt(limit.value).toString() : null,
    entries,
    remittances: entries.filter((e) => e.kind === 'expense'),
    levies: dues.rows,
  };
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

const LEVY_LIMIT_RULE = 'levy_expense_max_without_vote_paisa';
/** Charges the bank takes on its own: recorded even when the levy fund is empty, which shows a deficit. */
const MAY_GO_NEGATIVE: ReadonlySet<LevyExpenseCategory> = new Set(['bank_charge', 'sms_charge']);

export interface LevyExpenseInput {
  category: LevyExpenseCategory;
  amount_paisa: bigint;
  account: CashAccountCode;
  payee: string;
  note: string;
  receipt_file_id?: string | undefined;
  proposal_id?: string | null;
}

/**
 * Pay a running cost from the levy fund: `DR LEVY_CLEARING, CR <account>` plus its `levy_expenses`
 * row (category, payee, receipt). Only bank and SMS charges may take the fund below zero; anything
 * else must be covered by what is held. Shared by the cashier's direct entry and the `expense`
 * proposal paid from the levy fund.
 */
export async function postLevyExpense(tx: pg.PoolClient, actor: LedgerActor, entryDate: string, input: LevyExpenseInput): Promise<{ id: string; ledger_seq: string }> {
  const held = await accountBalance(tx, 'LEVY_CLEARING');
  if (!MAY_GO_NEGATIVE.has(input.category) && input.amount_paisa > held) {
    throw badRequest('levy.exceeds_held', `Only ${held.toString()} paisa of levy is held`);
  }
  if (input.receipt_file_id) {
    const file = await tx.query(`SELECT created_by FROM files WHERE id = $1`, [input.receipt_file_id]);
    const row = file.rows[0] as { created_by: string | null } | undefined;
    if (!row || row.created_by !== actor.userId) throw notFound('file.not_found', 'File not found');
  }
  const id = randomUUID();
  const posted = await postEntries(
    tx,
    [
      {
        entry_date: entryDate,
        debit: 'LEVY_CLEARING',
        credit: input.account,
        amount_paisa: input.amount_paisa,
        member_id: null,
        ref_type: 'levy_expense',
        ref_id: id,
        memo: `Levy fund, ${input.category.replace('_', ' ')}: ${input.payee} - ${input.note}`,
      },
    ],
    actor,
  );
  const seq = posted[0]!.seq.toString();
  await tx.query(
    `INSERT INTO levy_expenses (id, category, payee, note, amount_paisa, receipt_file_id, proposal_id, ledger_seq, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, input.category, input.payee, input.note, input.amount_paisa.toString(), input.receipt_file_id ?? null, input.proposal_id ?? null, seq, actor.userId],
  );
  return { id, ledger_seq: seq };
}

/**
 * `POST /levy/expenses` (cashier, step-up): a running cost up to the no-vote limit. Above it the
 * cashier raises an `expense` proposal paid from the levy fund. Registration and VAT are exempt:
 * the levy that pays them was itself voted for that purpose (the old registrar hand-over).
 */
export async function recordLevyExpense(deps: ObligationDeps, actor: LedgerActor, input: LevyExpense): Promise<{ id: string; ledger_seq: string }> {
  return inTransaction(deps.pool, async (tx) => {
    const today = deps.clock.todayDhaka();
    if (input.category !== 'registration') {
      const limit = toBigInt((await requireRule(tx, LEVY_LIMIT_RULE, today)).value);
      if (input.amount_paisa > limit) {
        throw badRequest('levy.needs_vote', `Above ${limit.toString()} paisa a levy expense needs a proposal`);
      }
    }
    return postLevyExpense(tx as pg.PoolClient, actor, today, input);
  });
}

/** Bank and SMS charges taken from the main fund that may still be moved onto the levy fund. */
const MOVABLE_ACCOUNTS = ['BANK_CHARGE', 'SMS_CHARGE'] as const;

export interface MovableCost {
  seq: string;
  entry_date: string;
  account: (typeof MOVABLE_ACCOUNTS)[number];
  amount_paisa: string;
  memo: string | null;
}

/** Old charges not yet moved and not reversed, oldest first, with their total. */
export async function listMovableCosts(db: Db): Promise<{ total_paisa: string; items: MovableCost[] }> {
  const res = await db.query(
    `SELECT e.seq::text AS seq, e.entry_date::text AS entry_date, e.debit_account AS account,
            e.amount_paisa::text AS amount_paisa, e.memo
     FROM ledger_entries e
     WHERE e.debit_account = ANY($1::text[]) AND e.reverses_seq IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_seq = e.seq)
       AND NOT EXISTS (SELECT 1 FROM levy_expenses x WHERE x.moved_from_seq = e.seq)
     ORDER BY e.entry_date, e.seq`,
    [MOVABLE_ACCOUNTS],
  );
  const items = res.rows as MovableCost[];
  return { total_paisa: items.reduce((n, i) => n + BigInt(i.amount_paisa), 0n).toString(), items };
}

/**
 * `POST /levy/move-old-costs` (cashier, step-up; ASSUMPTIONS 106): every bank and SMS charge still on
 * the main fund becomes a levy-fund cost. Each gets its own entry `DR LEVY_CLEARING, CR <charge
 * account>` (`ref_type` `levy_moved`) and a `levy_expenses` row naming the moved entry, which is
 * unique, so nothing moves twice. Members' capital gets the money back; the levy fund shows the
 * deficit, which the next voted levy covers. The old entries are never edited.
 */
export async function moveCostsToLevy(deps: ObligationDeps, actor: LedgerActor): Promise<{ moved: number; total_paisa: string }> {
  return inTransaction(deps.pool, async (tx) => {
    // One move at a time, so two clicks cannot both see the same charges as movable.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('levy_move_old_costs'))`);
    const { items, total_paisa } = await listMovableCosts(tx);
    const today = deps.clock.todayDhaka();
    for (const c of items) {
      const id = randomUUID();
      const posted = await postEntries(
        tx as pg.PoolClient,
        [
          {
            entry_date: today,
            debit: 'LEVY_CLEARING',
            credit: c.account,
            amount_paisa: BigInt(c.amount_paisa),
            member_id: null,
            ref_type: 'levy_moved',
            ref_id: id,
            memo: `Moved to the levy fund: entry #${c.seq}${c.memo ? ` (${c.memo})` : ''}`,
          },
        ],
        actor,
      );
      await tx.query(
        `INSERT INTO levy_expenses (id, category, payee, note, amount_paisa, ledger_seq, created_by, moved_from_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, c.account === 'SMS_CHARGE' ? 'sms_charge' : 'bank_charge', 'Bank', `Earlier cost from the main fund, entry #${c.seq} (${c.entry_date})`, c.amount_paisa, posted[0]!.seq.toString(), actor.userId, c.seq],
      );
    }
    return { moved: items.length, total_paisa };
  });
}

/** `POST /levy/remittances`: the registrar hand-over, now a levy expense of category `registration`. */
export async function remitLevy(
  deps: ObligationDeps,
  actor: LedgerActor,
  input: LevyRemit,
): Promise<{ ledger_seq: string }> {
  const { ledger_seq } = await recordLevyExpense(deps, actor, { ...input, category: 'registration' });
  return { ledger_seq };
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
