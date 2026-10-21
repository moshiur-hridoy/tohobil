import { bn, divRound, formatBDT, formatDateBn, periodEnd, periodStart, toBengaliDigits, type Clock } from '@barakah/shared';
import { charityStatement } from '../charity/service';
import { verifyLedger } from '../ledger/queries';
import { notFound } from '../lib/errors';
import { computeNav } from '../lib/nav';
import { toBigInt } from '../lib/money';
import type { Db } from '../lib/tx';
import { computeMemberFinancials } from '../members/status';
import { PdfWriter } from './pdf';

const L = bn.reports;
const money = (paisa: bigint | string | number): string => `৳${formatBDT(toBigInt(paisa), { digits: 'bn' })}`;
const day = (d: string): string => formatDateBn(d, { digits: 'bn' });
const num = (n: number | string): string => toBengaliDigits(String(n));

/** The date range a statement covers: a month, or a whole year. */
export function statementRange(period: string): { from: string; to: string; label: string } {
  if (/^\d{4}$/.test(period)) return { from: `${period}-01-01`, to: `${period}-12-31`, label: num(period) };
  return { from: periodStart(period), to: periodEnd(period), label: `${day(periodStart(period))} – ${day(periodEnd(period))}` };
}

async function member(db: Db, memberId: string): Promise<{ id: string; code: string; full_name: string }> {
  const res = await db.query(`SELECT id, code, full_name FROM members WHERE id = $1`, [memberId]);
  const row = res.rows[0] as { id: string; code: string; full_name: string } | undefined;
  if (!row) throw notFound('member.not_found', 'Member not found');
  return row;
}

/** One member's month or year: capital, dues, confirmed payments and fines. Figures are the ledger's, not recomputed. */
export async function memberStatementPdf(db: Db, clock: Clock, memberId: string, period: string): Promise<Buffer> {
  const m = await member(db, memberId);
  const range = statementRange(period);
  const today = clock.todayDhaka();
  const fin = await computeMemberFinancials(db, memberId, today);

  const paidIn = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN credit_account = 'MEMBER_CAPITAL' THEN amount_paisa ELSE -amount_paisa END), 0)::text AS total
     FROM ledger_entries
     WHERE member_id = $1 AND (credit_account = 'MEMBER_CAPITAL' OR debit_account = 'MEMBER_CAPITAL')
       AND entry_date BETWEEN $2::date AND $3::date`,
    [memberId, range.from, range.to],
  );
  const dues = await db.query(
    `SELECT period, kind, due_date::text AS due_date, amount_paisa::text AS amount_paisa,
            allocated_paisa::text AS allocated_paisa, outstanding_paisa::text AS outstanding_paisa
     FROM v_due_status WHERE member_id = $1 AND due_date BETWEEN $2::date AND $3::date ORDER BY due_date, kind`,
    [memberId, range.from, range.to],
  );
  const payments = await db.query(
    `SELECT (COALESCE(confirmed_at, paid_at) AT TIME ZONE 'Asia/Dhaka')::date::text AS day, method, purpose,
            amount_paisa::text AS amount_paisa
     FROM payments WHERE member_id = $1 AND status IN ('confirmed','reversed')
       AND (COALESCE(confirmed_at, paid_at) AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $2::date AND $3::date
     ORDER BY day, id`,
    [memberId, range.from, range.to],
  );
  const fines = await db.query(
    `SELECT (f.created_at AT TIME ZONE 'Asia/Dhaka')::date::text AS day, f.amount_paisa::text AS amount_paisa,
            f.waived_at, s.outstanding_paisa::text AS outstanding_paisa
     FROM fines f JOIN v_fine_status s ON s.fine_id = f.id
     WHERE f.member_id = $1 AND (f.created_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $2::date AND $3::date
     ORDER BY day, f.id`,
    [memberId, range.from, range.to],
  );

  const pdf = new PdfWriter(`${L.statementTitle} ${m.code}`, bn.app.name);
  pdf.heading(`${bn.app.name} — ${L.statementTitle}`, 18);
  pdf.keyValue(L.member, `${m.code} · ${m.full_name}`);
  pdf.keyValue(L.period, range.label);
  pdf.keyValue(L.generatedOn, day(today));
  pdf.space(6);
  pdf.keyValue(L.shares, num(fin.shares));
  pdf.keyValue(L.capitalNow, money(fin.capital));
  pdf.keyValue(L.capitalChange, money((paidIn.rows[0] as { total: string }).total));
  pdf.keyValue(L.pendingDues, money(fin.outstandingPrincipal + fin.outstandingFines));
  pdf.space(10);

  pdf.heading(L.dues, 12);
  const dueRows = dues.rows as Array<Record<string, string>>;
  pdf.table(
    [
      { header: L.what, width: 0.3 },
      { header: L.date, width: 0.22 },
      { header: L.amount, width: 0.16, align: 'right' },
      { header: L.paid, width: 0.16, align: 'right' },
      { header: L.outstanding, width: 0.16, align: 'right' },
    ],
    dueRows.length === 0
      ? [[L.none, '', '', '', '']]
      : dueRows.map((d) => [`${bn.pay.dueKind[d.kind as keyof typeof bn.pay.dueKind] ?? d.kind} · ${d.period}`, day(d.due_date!), money(d.amount_paisa!), money(d.allocated_paisa!), money(d.outstanding_paisa!)]),
  );

  pdf.heading(L.payments, 12);
  const payRows = payments.rows as Array<Record<string, string>>;
  pdf.table(
    [
      { header: L.date, width: 0.3 },
      { header: L.method, width: 0.3 },
      { header: L.purpose, width: 0.2 },
      { header: L.amount, width: 0.2, align: 'right' },
    ],
    payRows.length === 0
      ? [[L.none, '', '', '']]
      : payRows.map((p) => [day(p.day!), bn.payment.methods[p.method as keyof typeof bn.payment.methods] ?? p.method!, p.purpose!, money(p.amount_paisa!)]),
  );

  pdf.heading(L.fines, 12);
  const fineRows = fines.rows as Array<Record<string, string | Date | null>>;
  pdf.table(
    [
      { header: L.date, width: 0.3 },
      { header: L.status, width: 0.4 },
      { header: L.amount, width: 0.3, align: 'right' },
    ],
    fineRows.length === 0
      ? [[L.none, '', '']]
      : fineRows.map((f) => [day(f.day as string), f.waived_at ? L.waived : toBigInt(f.outstanding_paisa as string) > 0n ? L.open : L.settled, money(f.amount_paisa as string)]),
  );
  pdf.paragraph(L.statementNote, 9);
  return pdf.finish();
}

/** Figures only: capital, an estimate of what the shares are worth, and what is still owed. The member works out zakat themselves (spec 18.7). */
export async function zakatStatementPdf(db: Db, clock: Clock, memberId: string, asOf?: string): Promise<Buffer> {
  const m = await member(db, memberId);
  const date = asOf ?? clock.todayDhaka();
  const fin = await computeMemberFinancials(db, memberId, date);
  const nav = await computeNav(db, date);
  const estimate = nav.shares_outstanding > 0 ? divRound(nav.net_assets * BigInt(fin.shares), BigInt(nav.shares_outstanding)) : 0n;

  const pdf = new PdfWriter(`${L.zakatTitle} ${m.code}`, bn.app.name);
  pdf.heading(`${bn.app.name} — ${L.zakatTitle}`, 18);
  pdf.keyValue(L.member, `${m.code} · ${m.full_name}`);
  pdf.keyValue(L.asOf, day(date));
  pdf.space(8);
  pdf.keyValue(L.shares, num(fin.shares));
  pdf.keyValue(L.capitalNow, money(fin.capital));
  pdf.keyValue(L.navPerShare, money(nav.nav_per_share));
  pdf.keyValue(L.estimatedValue, money(estimate));
  pdf.keyValue(L.pendingDues, money(fin.outstandingPrincipal + fin.outstandingFines));
  pdf.space(10);
  pdf.paragraph(L.zakatNote);
  return pdf.finish();
}

/** The fund's year in one document: position, collections, charity, assets, decisions, and the audit and ledger checks. */
export async function annualSummaryPdf(db: Db, clock: Clock, year: string): Promise<Buffer> {
  const to = `${year}-12-31`;
  const nav = await computeNav(db, to);
  const one = async (sql: string, params: unknown[]): Promise<string> =>
    String(((await db.query(sql, params)).rows[0] as { v: string | number }).v);
  const collected = await one(
    `SELECT COALESCE(SUM(a.amount_paisa), 0)::text AS v FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id JOIN dues d ON d.id = a.due_id
      WHERE p.status = 'confirmed' AND d.kind IN ('monthly','start_boost','special') AND d.due_date BETWEEN $1::date AND $2::date`,
    [`${year}-01-01`, to],
  );
  const fines = await one(
    `SELECT COALESCE(SUM(amount_paisa), 0)::text AS v FROM fines WHERE created_at::date BETWEEN $1::date AND $2::date`,
    [`${year}-01-01`, to],
  );
  const members = await one(`SELECT count(*)::text AS v FROM members WHERE status IN ('active','warning')`, []);
  const executed = await one(
    `SELECT count(*)::text AS v FROM proposals WHERE status = 'executed' AND executed_at::date BETWEEN $1::date AND $2::date`,
    [`${year}-01-01`, to],
  );
  const locked = await one(`SELECT count(*)::text AS v FROM periods WHERE period LIKE $1 || '-%' AND locked_at IS NOT NULL`, [year]);
  const charity = await charityStatement(db, year);
  const assets = (
    await db.query(
      `SELECT a.name, a.status, a.cost_paisa::text AS cost_paisa,
              (SELECT value_paisa::text FROM asset_valuations v WHERE v.asset_id = a.id ORDER BY v.as_of DESC, v.created_at DESC LIMIT 1) AS value_paisa
       FROM assets a WHERE a.status IN ('held','acquiring','sold') ORDER BY a.created_at`,
    )
  ).rows as Array<{ name: string; status: string; cost_paisa: string; value_paisa: string | null }>;
  const signed = await db.query(
    `SELECT decided_at::date::text AS day FROM approvals WHERE kind = 'annual_audit' AND ref_id = $1 AND status = 'approved'`,
    [year],
  );
  const ledger = await verifyLedger(db);

  const pdf = new PdfWriter(`${L.annualTitle} ${year}`, bn.app.name);
  pdf.heading(`${bn.app.name} — ${L.annualTitle} ${num(year)}`, 18);
  pdf.keyValue(L.generatedOn, day(clock.todayDhaka()));
  pdf.space(8);
  pdf.keyValue(L.netAssets, money(nav.net_assets));
  pdf.keyValue(L.navPerShare, money(nav.nav_per_share));
  pdf.keyValue(L.totalShares, num(nav.shares_outstanding));
  pdf.keyValue(L.activeMembers, num(members));
  pdf.keyValue(L.duesCollected, money(collected));
  pdf.keyValue(L.finesRaised, money(fines));
  pdf.keyValue(L.proposals, num(executed));
  pdf.space(10);
  pdf.heading(L.charity, 12);
  pdf.keyValue(L.charityOpening, money(charity.opening_paisa));
  pdf.keyValue(L.charityReceipts, money(charity.receipts_paisa));
  pdf.keyValue(L.charityDisbursements, money(charity.disbursements_paisa));
  pdf.keyValue(L.charityClosing, money(charity.closing_paisa));
  pdf.space(10);
  pdf.heading(L.assets, 12);
  pdf.table(
    [
      { header: L.what, width: 0.4 },
      { header: L.status, width: 0.2 },
      { header: L.assetCost, width: 0.2, align: 'right' },
      { header: L.assetValue, width: 0.2, align: 'right' },
    ],
    assets.length === 0
      ? [[L.none, '', '', '']]
      : assets.map((a) => [a.name, bn.assetsAdmin.status[a.status as keyof typeof bn.assetsAdmin.status] ?? a.status, money(a.cost_paisa), a.value_paisa ? money(a.value_paisa) : '—']),
  );
  pdf.heading(L.audit, 12);
  pdf.keyValue(L.lockedMonths, `${num(locked)} / ${num(12)}`);
  pdf.keyValue(L.audit, signed.rows[0] ? `${L.auditSigned} · ${day((signed.rows[0] as { day: string }).day)}` : L.none);
  pdf.keyValue(L.ledgerCheck, `${ledger.ok ? L.ledgerOk : L.ledgerBroken} · ${num(ledger.count)} ${L.entries}`);
  return pdf.finish();
}
