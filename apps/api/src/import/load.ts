import type pg from 'pg';
import { toDhakaDate, type PaymentMethod } from '@barakah/shared';
import { LEDGER_REF, postEntries, type PostingInput } from '../ledger/service';
import { paymentPostings, ribaReceivedPosting } from '../ledger/postings';
import { audit } from '../lib/audit';
import { toBigInt } from '../lib/money';
import { inTransaction } from '../lib/tx';
import {
  planDefaultAllocation,
  planManualAllocation,
  type AllocationPlan,
  type Outstanding,
} from '../payments/allocation';
import { ImportError } from './dataset';
import type { Dataset } from './schemas';

/**
 * Stage 2 of the legacy import (Doc.md 13): validated rows go into the database through the same
 * posting service and allocation rules the API uses, with `source='import'`.
 *
 * The whole load is ONE transaction. `commit: false` (the default of the CLI) runs everything, then
 * rolls back, so a dry run reports exactly what a real run would do and writes nothing.
 */

export interface LoadOptions {
  commit: boolean;
}

export interface LoadReport {
  committed: boolean;
  counts: Record<string, number>;
  ledger_entries: number;
  /** Differences between the sheet's actual balances and what the postings give, per account. */
  opening_adjustments: Array<{ account: string; sheet_paisa: string; system_paisa: string; adjustment_paisa: string }>;
  warnings: string[];
}

class DryRun extends Error {}

const CASH_ACCOUNTS = ['CASH', 'BANK', 'BKASH', 'NAGAD'] as const;

/** Refuse anything that is not a local database, unless the caller says so explicitly. */
export function assertSafeTarget(databaseUrl: string, nodeEnv: string | undefined, allowRemote: boolean): void {
  const host = new URL(databaseUrl).hostname;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', 'db'].includes(host);
  if ((!local || nodeEnv === 'production') && !allowRemote) {
    throw new ImportError(
      `Refusing to load into ${host}${nodeEnv === 'production' ? ' (NODE_ENV=production)' : ''}: the importer runs against a local database. ` +
        'For a staging or cutover run pass --allow-remote, after reading docs/RUNBOOK.md.',
    );
  }
}

interface DueRef {
  id: string;
  due_date: string;
  period: string;
  kind: string;
  outstanding: bigint;
}
interface FineRef {
  id: string;
  period: string;
  created_date: string;
  outstanding: bigint;
}

async function openItems(tx: pg.PoolClient, memberId: string): Promise<{ dues: DueRef[]; fines: FineRef[] }> {
  const dues = await tx.query(
    `SELECT due_id AS id, due_date::text AS due_date, period, kind, outstanding_paisa
     FROM v_due_status
     WHERE member_id = $1 AND outstanding_paisa > 0 AND kind IN ('monthly','start_boost')
     ORDER BY due_date, due_id`,
    [memberId],
  );
  const fines = await tx.query(
    `SELECT s.fine_id AS id, d.period, (f.created_at AT TIME ZONE 'Asia/Dhaka')::date::text AS created_date,
            s.outstanding_paisa
     FROM v_fine_status s
     JOIN fines f ON f.id = s.fine_id
     LEFT JOIN dues d ON d.id = f.due_id
     WHERE s.member_id = $1 AND s.outstanding_paisa > 0
     ORDER BY f.created_at, f.id`,
    [memberId],
  );
  return {
    dues: (dues.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'] as string,
      due_date: r['due_date'] as string,
      period: r['period'] as string,
      kind: r['kind'] as string,
      outstanding: toBigInt(r['outstanding_paisa']),
    })),
    fines: (fines.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'] as string,
      period: (r['period'] as string | null) ?? '',
      created_date: r['created_date'] as string,
      outstanding: toBigInt(r['outstanding_paisa']),
    })),
  };
}

const outstandingOf = (items: ReadonlyArray<{ id: string; outstanding: bigint }>): Outstanding[] =>
  items.map((i) => ({ id: i.id, outstanding: i.outstanding }));

async function ledgerBalance(tx: pg.PoolClient, account: string): Promise<bigint> {
  const res = await tx.query(
    `SELECT COALESCE(SUM(CASE WHEN debit_account = $1 THEN amount_paisa ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN credit_account = $1 THEN amount_paisa ELSE 0 END), 0) AS net
     FROM ledger_entries`,
    [account],
  );
  return toBigInt((res.rows[0] as { net: unknown }).net);
}

/** Problems that can be found without touching the database. */
export function precheck(ds: Dataset): string[] {
  const problems: string[] = [];
  const keys = new Set(ds.members.map((m) => m.member_key));
  const seenTrx = new Map<string, string>();
  const seenPay = new Set<string>();
  for (const p of ds.payments) {
    if (seenPay.has(p.payment_key)) problems.push(`payment_key ${p.payment_key} appears twice`);
    seenPay.add(p.payment_key);
    if (p.trx_id) {
      const norm = p.trx_id.trim().toUpperCase();
      const prior = seenTrx.get(norm);
      if (prior) problems.push(`Duplicate TrxID ${norm}: payments ${prior} and ${p.payment_key}`);
      else seenTrx.set(norm, p.payment_key);
    }
  }
  for (const [file, rows] of [
    ['share_holdings', ds.share_holdings],
    ['share_register', ds.share_register],
    ['dues', ds.dues],
    ['fines', ds.fines],
    ['payments', ds.payments],
    ['allocations', ds.allocations],
    ['expected_totals', ds.expected_totals],
  ] as const) {
    for (const r of rows) {
      if (!keys.has(r.member_key)) problems.push(`${file}: member_key ${r.member_key} is not in members.csv`);
    }
  }
  for (const f of ds.fines) {
    if (f.status === 'waived') {
      problems.push(
        `fines: ${f.member_key} ${f.period} is waived, but a waiver needs an executed fine_waiver proposal (Phase 3); import it as paid or unpaid`,
      );
    }
    if (!ds.dues.some((d) => d.member_key === f.member_key && d.period === f.period)) {
      problems.push(`fines: ${f.member_key} ${f.period} has no due in dues.csv`);
    }
  }
  const payKeys = new Set(ds.payments.map((p) => p.payment_key));
  for (const a of ds.allocations) {
    if (!payKeys.has(a.payment_key)) problems.push(`allocations: unknown payment_key ${a.payment_key}`);
  }
  for (const a of ds.assets) {
    if (!a.acquired_on) problems.push(`assets: ${a.asset_key} has no acquired_on date to book its cost on`);
  }
  const assetKeys = new Set(ds.assets.map((a) => a.asset_key));
  for (const v of ds.valuations) {
    if (!assetKeys.has(v.asset_key)) problems.push(`valuations: unknown asset_key ${v.asset_key}`);
  }
  return problems;
}

export async function loadDataset(pool: pg.Pool, ds: Dataset, opts: LoadOptions): Promise<LoadReport> {
  const problems = precheck(ds);
  if (problems.length > 0) throw new ImportError('Refusing to load', problems);

  const report: LoadReport = { committed: false, counts: {}, ledger_entries: 0, opening_adjustments: [], warnings: [] };
  const count = (name: string, n = 1): void => void (report.counts[name] = (report.counts[name] ?? 0) + n);

  try {
    await inTransaction(pool, async (tx) => {
      const already = await tx.query(`SELECT 1 FROM payments WHERE source = 'import' LIMIT 1`);
      if ((already.rowCount ?? 0) > 0) {
        throw new ImportError('This database already holds imported payments; the importer runs once per database');
      }
      const ledgerBefore = toBigInt(((await tx.query(`SELECT count(*) AS n FROM ledger_entries`)).rows[0] as { n: unknown }).n);
      const actor = { userId: null as string | null };

      // ---- members, shares, register ------------------------------------------------------
      const memberId = new Map<string, string>();
      for (const m of ds.members) {
        const found = await tx.query(`SELECT id, full_name, phone FROM members WHERE code = $1`, [m.member_key]);
        const row = found.rows[0] as { id: string; full_name: string; phone: string } | undefined;
        if (row) {
          if (row.full_name !== m.full_name || row.phone !== m.phone) {
            throw new ImportError(`Member ${m.member_key} already exists with a different name or phone`);
          }
          memberId.set(m.member_key, row.id);
          continue;
        }
        const ins = await tx.query(
          `INSERT INTO members (code, full_name, phone, joined_on, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [m.member_key, m.full_name, m.phone, m.joined_on, m.status],
        );
        const id = (ins.rows[0] as { id: string }).id;
        await tx.query(`INSERT INTO users (member_id) VALUES ($1)`, [id]);
        memberId.set(m.member_key, id);
        count('members');
      }
      const mid = (key: string): string => memberId.get(key) as string;

      for (const h of ds.share_holdings) {
        await tx.query(
          `INSERT INTO share_holdings (member_id, shares, effective_from, source) VALUES ($1,$2,$3,'import')`,
          [mid(h.member_key), h.shares, h.effective_from],
        );
        count('share_holdings');
      }
      for (const r of ds.share_register) {
        await tx.query(
          `INSERT INTO share_register (share_no, member_id, registered_name, nominee_name, nominee_relation)
           VALUES ($1,$2,$3,$4,$5)`,
          [r.share_no, mid(r.member_key), r.registered_name, r.nominee_name, r.nominee_relation],
        );
        count('share_register');
      }

      // ---- dues and fines (amounts come from the sheet, not from the rules) -----------------
      const dueId = new Map<string, string>(); // member|period|kind
      for (const d of ds.dues) {
        await tx.query(`INSERT INTO periods (period) VALUES ($1) ON CONFLICT DO NOTHING`, [d.period]);
        const ins = await tx.query(
          `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
           VALUES ($1,$2,$3,$4,$5::bigint,$6) RETURNING id`,
          [mid(d.member_key), d.period, d.kind, d.shares_snapshot, d.amount_paisa.toString(), d.due_date],
        );
        dueId.set(`${d.member_key}|${d.period}|${d.kind}`, (ins.rows[0] as { id: string }).id);
        count('dues');
      }
      const dueFor = (key: string, period: string): string =>
        (dueId.get(`${key}|${period}|monthly`) ?? dueId.get(`${key}|${period}|start_boost`)) as string;
      for (const f of ds.fines) {
        // Created the day after the due date, as the fine job would have (5.5).
        await tx.query(
          `INSERT INTO fines (due_id, member_id, kind, amount_paisa, reason, created_at)
           SELECT d.id, d.member_id, 'late_payment', $2::bigint, 'late_payment',
                  ((d.due_date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka')
           FROM dues d WHERE d.id = $1`,
          [dueFor(f.member_key, f.period), f.amount_paisa.toString()],
        );
        count('fines');
      }

      // ---- assets: DR INVESTMENTS_AT_COST, CR the paying account ----------------------------
      const assetIds = new Map<string, string>();
      const partnerIds = new Map<string, string>();
      for (const a of ds.assets) {
        let partnerId: string | null = null;
        if (a.partner) {
          partnerId = partnerIds.get(a.partner) ?? null;
          if (!partnerId) {
            const p = await tx.query(
              `INSERT INTO investment_partners (kind, name) VALUES ($1,$2) RETURNING id`,
              [a.kind, a.partner],
            );
            partnerId = (p.rows[0] as { id: string }).id;
            partnerIds.set(a.partner, partnerId);
            count('investment_partners');
          }
        }
        const ins = await tx.query(
          `INSERT INTO assets (kind, name, acquired_on, cost_paisa, quantity, unit, status, partner_id)
           VALUES ($1,$2,$3,$4::bigint,$5::numeric,$6,$7,$8) RETURNING id`,
          [a.kind, a.name, a.acquired_on, a.cost_paisa.toString(), a.quantity, a.unit, a.status, partnerId],
        );
        const id = (ins.rows[0] as { id: string }).id;
        assetIds.set(a.asset_key, id);
        if (a.cost_paisa > 0n) {
          await postEntries(
            tx,
            [{
              entry_date: a.acquired_on as string,
              debit: 'INVESTMENTS_AT_COST',
              credit: a.source_account,
              amount_paisa: a.cost_paisa,
              ref_type: LEDGER_REF.import,
              ref_id: id,
              memo: `Asset ${a.asset_key} ${a.name} (legacy import)`,
            }],
            actor,
            { exactAccounts: true },
          );
        }
        count('assets');
      }

      // ---- valuations: what the shop says a purchase is worth now; no cash moves -------------
      for (const v of ds.valuations) {
        await tx.query(
          `INSERT INTO asset_valuations (asset_id, value_paisa, as_of, basis) VALUES ($1, $2::bigint, $3, $4)`,
          [assetIds.get(v.asset_key), v.value_paisa.toString(), v.as_of, v.basis],
        );
        count('valuations');
      }

      // ---- miscellaneous entries ------------------------------------------------------------
      for (const e of ds.misc_ledger) {
        const entry: PostingInput =
          e.debit_account === 'BANK' && e.credit_account === 'CHARITY_PAYABLE'
            ? ribaReceivedPosting({ entryDate: e.entry_date, amountPaisa: e.amount_paisa, memo: e.memo })
            : {
                entry_date: e.entry_date,
                debit: e.debit_account,
                credit: e.credit_account,
                amount_paisa: e.amount_paisa,
                member_id: e.member_key ? mid(e.member_key) : null,
                ref_type: LEDGER_REF.import,
                memo: `${e.memo} (legacy import)`,
              };
        await postEntries(tx, [entry], actor, { exactAccounts: true });
        count('misc_ledger');
      }

      // ---- payments, oldest first -----------------------------------------------------------
      const manualFor = new Map<string, typeof ds.allocations>();
      for (const a of ds.allocations) manualFor.set(a.payment_key, [...(manualFor.get(a.payment_key) ?? []), a]);

      const ordered = [...ds.payments].sort(
        (a, b) => new Date(a.paid_at).getTime() - new Date(b.paid_at).getTime() || a.payment_key.localeCompare(b.payment_key),
      );
      for (const p of ordered) {
        const member = mid(p.member_key);
        if (p.trx_id) {
          const dup = await tx.query(
            `SELECT 1 FROM payments WHERE upper(trim(trx_id)) = upper(trim($1)) AND status IN ('pending','confirmed')`,
            [p.trx_id],
          );
          if ((dup.rowCount ?? 0) > 0) throw new ImportError(`TrxID ${p.trx_id} already exists in the database`);
        }
        const paidDate = toDhakaDate(new Date(p.paid_at));
        const ins = await tx.query(
          `INSERT INTO payments (member_id, amount_paisa, method, purpose, trx_id, paid_at, source, raw_sms, note)
           VALUES ($1,$2::bigint,$3,'dues',$4,$5,'import',$6,$7) RETURNING id`,
          [member, p.amount_paisa.toString(), p.method, p.trx_id, p.paid_at, p.raw_sms, p.note ?? `legacy import ${p.payment_key}`],
        );
        const paymentId = (ins.rows[0] as { id: string }).id;

        const open = await openItems(tx, member);
        let plan: AllocationPlan;
        const manual = manualFor.get(p.payment_key);
        if (manual) {
          const lines = manual.map((a) => {
            const due = open.dues.find((d) => d.period === a.period);
            const fine = open.fines.find((f) => f.period === a.period);
            const target = a.kind === 'principal' ? due : fine;
            if (!target) {
              throw new ImportError(`allocations: ${a.payment_key} points at ${a.kind} of ${a.period}, which is not open for ${a.member_key}`);
            }
            return a.kind === 'principal'
              ? { due_id: target.id, amount_paisa: a.amount_paisa }
              : { fine_id: target.id, amount_paisa: a.amount_paisa };
          });
          plan = planManualAllocation(p.amount_paisa, lines, outstandingOf(open.dues), outstandingOf(open.fines));
        } else {
          // What existed on the payment date: dues from the first of their month, fines from the day
          // after their due date. The default order then applies as it would have then.
          const dues = open.dues.filter((d) => `${d.period}-01` <= paidDate);
          const fines = open.fines.filter((f) => f.created_date <= paidDate);
          plan = planDefaultAllocation(p.amount_paisa, outstandingOf(dues), outstandingOf(fines));
        }

        // The database only lets confirmed payments carry allocations, so confirm first.
        await tx.query(
          `UPDATE payments SET status = 'confirmed', confirmed_at = paid_at, unallocated_paisa = $2::bigint WHERE id = $1`,
          [paymentId, plan.credit.toString()],
        );
        for (const line of plan.lines) {
          await tx.query(
            `INSERT INTO payment_allocations (payment_id, due_id, fine_id, amount_paisa) VALUES ($1,$2,$3,$4::bigint)`,
            [paymentId, line.due_id ?? null, line.fine_id ?? null, line.amount.toString()],
          );
          count('allocations');
        }
        await postEntries(
          tx,
          paymentPostings({
            entryDate: paidDate,
            method: p.method as PaymentMethod,
            memberId: member,
            paymentId,
            principalPaisa: plan.principal,
            creditPaisa: plan.credit,
            finePaisa: plan.fine,
          }),
          actor,
          { exactAccounts: true },
        );
        count('payments');
      }

      // ---- leftover credit pays dues still open (an advance payment); no new posting ----------
      const credits = await tx.query(
        `SELECT id, member_id, unallocated_paisa FROM payments
         WHERE source = 'import' AND status = 'confirmed' AND unallocated_paisa > 0
         ORDER BY paid_at, id`,
      );
      for (const c of credits.rows as Array<{ id: string; member_id: string; unallocated_paisa: unknown }>) {
        const open = await openItems(tx, c.member_id);
        const credit = toBigInt(c.unallocated_paisa);
        // dues only, like the API's own credit rule (5.3); fines are never paid from credit
        const plan = planDefaultAllocation(credit, outstandingOf(open.dues), []);
        if (plan.lines.length === 0) continue;
        for (const line of plan.lines) {
          await tx.query(
            `INSERT INTO payment_allocations (payment_id, due_id, fine_id, amount_paisa) VALUES ($1,$2,$3,$4::bigint)`,
            [c.id, line.due_id ?? null, line.fine_id ?? null, line.amount.toString()],
          );
          count('allocations');
        }
        await tx.query(`UPDATE payments SET unallocated_paisa = $2::bigint WHERE id = $1`, [c.id, plan.credit.toString()]);
        report.warnings.push(`A payment of member ${c.member_id} had ${credit} paisa of credit; ${credit - plan.credit} paisa was applied to open dues or fines`);
      }

      // ---- opening balances: post the difference to OPENING_ADJUSTMENT -----------------------
      for (const o of ds.opening_balances) {
        const system = await ledgerBalance(tx, o.account);
        const diff = o.actual_balance_paisa - system;
        report.opening_adjustments.push({
          account: o.account,
          sheet_paisa: o.actual_balance_paisa.toString(),
          system_paisa: system.toString(),
          adjustment_paisa: diff.toString(),
        });
        if (diff === 0n) continue;
        const [debit, credit] = diff > 0n ? [o.account, 'OPENING_ADJUSTMENT'] : ['OPENING_ADJUSTMENT', o.account];
        await postEntries(
          tx,
          [{
            entry_date: o.as_of,
            debit,
            credit,
            amount_paisa: diff > 0n ? diff : -diff,
            ref_type: LEDGER_REF.import,
            memo: `Opening adjustment ${o.account}: sheet ${o.actual_balance_paisa}, postings ${system}`,
          }],
          actor,
          { exactAccounts: true },
        );
        count('opening_adjustments');
      }
      const covered = new Set(ds.opening_balances.map((o) => o.account));
      for (const account of CASH_ACCOUNTS) {
        const bal = await ledgerBalance(tx, account);
        if (!covered.has(account) && bal !== 0n) {
          report.warnings.push(`${account} has a balance of ${bal} paisa but opening_balances.csv has no row for it`);
        }
      }

      const ledgerAfter = toBigInt(((await tx.query(`SELECT count(*) AS n FROM ledger_entries`)).rows[0] as { n: unknown }).n);
      report.ledger_entries = Number(ledgerAfter - ledgerBefore);

      await audit(tx, {
        actor: null,
        action: 'import.load',
        entityType: 'import',
        after: { counts: report.counts, ledger_entries: report.ledger_entries, committed: opts.commit },
      });
      if (!opts.commit) throw new DryRun();
    });
    report.committed = true;
  } catch (err) {
    if (!(err instanceof DryRun)) throw err;
  }
  return report;
}
