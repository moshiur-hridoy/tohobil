import type { Db } from '../lib/tx';

/** A byte-order mark makes spreadsheets read Bengali text as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** One CSV cell: quotes and commas escaped, and a leading =,+,-,@ neutralised so a spreadsheet never runs a formula. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`; // BOM: spreadsheets open Bengali text correctly
}

export interface CsvOptions {
  from?: string | undefined;
  to?: string | undefined;
  /** Phone numbers are for the cashier and auditor only (spec 11). */
  includePhones?: boolean;
}

interface Spec {
  columns: string[];
  sql: string;
  /** Which of the optional `from`/`to` the query takes: both, only `to` (an as-of date), or neither. */
  takes?: 'range' | 'as_of' | 'none';
}

const SPECS: Record<string, Spec> = {
  ledger: {
    columns: ['seq', 'entry_date', 'debit_account', 'credit_account', 'amount_paisa', 'member_code', 'ref_type', 'ref_id', 'memo', 'reverses_seq', 'hash'],
    sql: `SELECT e.seq::text AS seq, e.entry_date::text AS entry_date, e.debit_account, e.credit_account,
                 e.amount_paisa::text AS amount_paisa, m.code AS member_code, e.ref_type, e.ref_id::text AS ref_id,
                 e.memo, e.reverses_seq::text AS reverses_seq, e.hash
          FROM ledger_entries e LEFT JOIN members m ON m.id = e.member_id
          WHERE ($1::date IS NULL OR e.entry_date >= $1::date) AND ($2::date IS NULL OR e.entry_date <= $2::date)
          ORDER BY e.seq`,
  },
  // Raw SMS text and proof images stay out: only the payer, cashier and auditor may see them (spec 11).
  payments: {
    columns: ['id', 'member_code', 'amount_paisa', 'method', 'purpose', 'status', 'trx_id', 'paid_at', 'confirmed_at', 'source'],
    sql: `SELECT p.id::text AS id, m.code AS member_code, p.amount_paisa::text AS amount_paisa, p.method, p.purpose,
                 p.status, p.trx_id, p.paid_at, p.confirmed_at, p.source
          FROM payments p JOIN members m ON m.id = p.member_id
          WHERE ($1::date IS NULL OR p.paid_at::date >= $1::date) AND ($2::date IS NULL OR p.paid_at::date <= $2::date)
          ORDER BY p.paid_at, p.id`,
  },
  dues: {
    columns: ['member_code', 'period', 'kind', 'shares_snapshot', 'amount_paisa', 'due_date', 'allocated_paisa', 'outstanding_paisa', 'status'],
    sql: `SELECT m.code AS member_code, v.period, v.kind, v.shares_snapshot, v.amount_paisa::text AS amount_paisa,
                 v.due_date::text AS due_date, v.allocated_paisa::text AS allocated_paisa,
                 v.outstanding_paisa::text AS outstanding_paisa, v.status
          FROM v_due_status v JOIN members m ON m.id = v.member_id
          WHERE ($1::date IS NULL OR v.due_date >= $1::date) AND ($2::date IS NULL OR v.due_date <= $2::date)
          ORDER BY v.period, m.code, v.kind`,
  },
  fines: {
    columns: ['member_code', 'kind', 'amount_paisa', 'reason', 'created_at', 'waived_at', 'outstanding_paisa'],
    sql: `SELECT m.code AS member_code, f.kind, f.amount_paisa::text AS amount_paisa, f.reason, f.created_at, f.waived_at,
                 s.outstanding_paisa::text AS outstanding_paisa
          FROM fines f JOIN members m ON m.id = f.member_id JOIN v_fine_status s ON s.fine_id = f.id
          WHERE ($1::date IS NULL OR f.created_at::date >= $1::date) AND ($2::date IS NULL OR f.created_at::date <= $2::date)
          ORDER BY f.created_at, f.id`,
  },
  votes: {
    columns: ['proposal_id', 'proposal_title', 'member_code', 'choice', 'weight', 'cast_at', 'superseded_at'],
    sql: `SELECT v.proposal_id::text AS proposal_id, p.title AS proposal_title, m.code AS member_code, v.choice,
                 pv.weight::text AS weight, v.cast_at, v.superseded_at
          FROM votes v
          JOIN proposals p ON p.id = v.proposal_id
          JOIN members m ON m.id = v.member_id
          LEFT JOIN proposal_voters pv ON pv.proposal_id = v.proposal_id AND pv.member_id = v.member_id
          WHERE p.status <> 'open' -- ballots stay secret until the vote closes
            AND ($1::date IS NULL OR v.cast_at::date >= $1::date) AND ($2::date IS NULL OR v.cast_at::date <= $2::date)
          ORDER BY v.cast_at, v.id`,
  },
  proposals: {
    columns: ['id', 'type', 'title', 'status', 'opens_at', 'closes_at', 'finalized_at', 'executed_at', 'yes_count', 'no_count', 'abstain_count'],
    sql: `SELECT id::text AS id, type, title, status, opens_at, closes_at, finalized_at, executed_at,
                 CASE WHEN status = 'open' THEN NULL ELSE yes_count END AS yes_count,
                 CASE WHEN status = 'open' THEN NULL ELSE no_count END AS no_count,
                 CASE WHEN status = 'open' THEN NULL ELSE abstain_count END AS abstain_count
          FROM proposals
          WHERE ($1::date IS NULL OR created_at::date >= $1::date) AND ($2::date IS NULL OR created_at::date <= $2::date)
          ORDER BY created_at, id`,
  },
  assets: {
    columns: ['id', 'kind', 'name', 'status', 'cost_paisa', 'acquired_on', 'sold_on', 'sale_price_paisa', 'legal_owner_name'],
    sql: `SELECT id::text AS id, kind, name, status, cost_paisa::text AS cost_paisa, acquired_on::text AS acquired_on,
                 sold_on::text AS sold_on, sale_price_paisa::text AS sale_price_paisa, legal_owner_name
          FROM assets ORDER BY created_at, id`,
    takes: 'none',
  },
  valuations: {
    columns: ['asset_id', 'asset_name', 'value_paisa', 'as_of', 'basis'],
    sql: `SELECT v.asset_id::text AS asset_id, a.name AS asset_name, v.value_paisa::text AS value_paisa, v.as_of::text AS as_of, v.basis
          FROM asset_valuations v JOIN assets a ON a.id = v.asset_id
          WHERE ($1::date IS NULL OR v.as_of >= $1::date) AND ($2::date IS NULL OR v.as_of <= $2::date)
          ORDER BY v.as_of, v.id`,
  },
  members: {
    columns: ['code', 'full_name', 'status', 'joined_on', 'shares', 'capital_paisa'],
    sql: `SELECT m.code, m.full_name, m.status, m.joined_on::text AS joined_on,
                 shares_on(m.id, COALESCE($1::date, today_dhaka())) AS shares, b.capital_paisa::text AS capital_paisa
          FROM members m JOIN v_member_balances b ON b.member_id = m.id
          ORDER BY m.code`,
    takes: 'as_of',
  },
};

export const CSV_ENTITIES = Object.keys(SPECS);

export async function buildCsv(db: Db, entity: string, opts: CsvOptions = {}): Promise<{ csv: string; rows: number }> {
  const spec = SPECS[entity];
  if (!spec) throw new Error(`Unknown CSV entity ${entity}`);
  const params = spec.takes === 'none' ? [] : spec.takes === 'as_of' ? [opts.to ?? null] : [opts.from ?? null, opts.to ?? null];
  const res = await db.query(spec.sql, params);
  let columns = spec.columns;
  let rows = res.rows as Array<Record<string, unknown>>;
  if (entity === 'members' && opts.includePhones) {
    const phones = await db.query(`SELECT code, phone FROM members`);
    const byCode = new Map((phones.rows as Array<{ code: string; phone: string }>).map((p) => [p.code, p.phone]));
    columns = [...columns, 'phone'];
    rows = rows.map((r) => ({ ...r, phone: byCode.get(r.code as string) }));
  }
  return { csv: toCsv(columns, rows), rows: rows.length };
}
