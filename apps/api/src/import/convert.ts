import { dateInPeriod, tryParseBDT } from '@barakah/shared';
import { parsePaymentSms } from '../payments/sms-parser';
import { isBlankRow, parseCsv, toCsv } from './csv';
import { FILES, type NormalizedName } from './schemas';

/**
 * Stage 1 of the legacy import (Doc.md 13): the tabs of the Google Sheet, exported as CSV, become the
 * normalized CSVs plus a list of every row that needs a human decision. Pure: no files, no database.
 *
 * The converter never guesses silently. Whatever it had to assume (a placeholder phone, a default
 * source account, a due date that disagrees with the 20th) is added to the review list with a
 * suggested value; the owner edits the normalized CSVs and runs `load`.
 */

export const RAW_TABS = {
  shareHolder: 'Share Holder.csv',
  collection: 'Collection 26.csv',
  transaction: 'Transection.csv',
  investments: 'Investments.csv',
  miscellaneous: 'Miscellaneous.csv',
  dashboard: 'Dashboard.csv',
  openingBalances: 'Opening Balances.csv',
} as const;

export type RawTabs = Partial<Record<keyof typeof RAW_TABS, string>>;

export interface ReviewRow {
  file: string;
  row: string;
  what: string;
  why: string;
  suggested: string;
}

export const REVIEW_COLUMNS = ['file', 'row', 'what', 'why', 'suggested'] as const;

export interface ConvertResult {
  /** Normalized CSV text per file name (`members.csv`, ...). */
  files: Record<NormalizedName, string>;
  review: ReviewRow[];
}

const FUND_START = '2025-12-31'; // the Start Boost date: when the group began collecting
const YEAR = 2026;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

const cell = (row: readonly string[], i: number): string => (row[i] ?? '').trim();

/** "20 Jan 2026", "20-Jan-2026" or "20/01/2026" to YYYY-MM-DD, else null. */
export function parseSheetDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]*(\d{4})$/.exec(t);
  if (m) {
    const mm = MONTH_ABBR.indexOf((m[2] as string).toLowerCase());
    if (mm < 0) return null;
    return check(`${m[3]}-${String(mm + 1).padStart(2, '0')}-${(m[1] as string).padStart(2, '0')}`);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return check(`${m[3]}-${(m[2] as string).padStart(2, '0')}-${(m[1] as string).padStart(2, '0')}`);
  return null;
}

function check(iso: string): string | null {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Period and kind for a label of the collection or transaction tabs. */
function labelPeriod(label: string): { period: string; kind: 'start_boost' | 'monthly' } | null {
  const l = label.trim().toLowerCase();
  if (l === 'start boost') return { period: '2025-12', kind: 'start_boost' };
  const i = MONTHS.indexOf(l);
  if (i < 0) return null;
  return { period: `${YEAR}-${String(i + 1).padStart(2, '0')}`, kind: 'monthly' };
}

const paisa = (text: string): bigint | null => {
  const t = text.trim();
  return t === '' || t === '-' ? null : tryParseBDT(t);
};

function normalizeMethod(text: string): 'bkash' | 'nagad' | 'bank' | 'cash' | 'other' {
  const t = text.trim().toLowerCase();
  if (/b\s?ka?sh|baksh/.test(t)) return 'bkash';
  if (/nagad/.test(t)) return 'nagad';
  if (/bank|cheque/.test(t)) return 'bank';
  if (/cash/.test(t)) return 'cash';
  return 'other';
}

export function convertSheet(tabs: RawTabs): ConvertResult {
  const review: ReviewRow[] = [];
  const flag = (file: string, row: string | number, what: string, why: string, suggested = ''): void => {
    review.push({ file, row: String(row), what, why, suggested });
  };

  const out: Record<NormalizedName, string[][]> = {
    members: [],
    share_holdings: [],
    share_register: [],
    dues: [],
    fines: [],
    payments: [],
    allocations: [],
    assets: [],
    // the sheet records no valuations; the owner adds them by hand
    valuations: [],
    misc_ledger: [],
    opening_balances: [],
    expected_totals: [],
  };

  // ---- Share Holder: the register and the owners (the members) ---------------------------------
  const ownerKey = new Map<string, string>(); // owner name -> M01
  const ownerShares = new Map<string, number>();
  if (tabs.shareHolder !== undefined) {
    const rows = parseCsv(tabs.shareHolder);
    const register: string[][] = [];
    const owners: Array<{ name: string; shares: number }> = [];
    let section: 'none' | 'register' | 'owners' = 'none';
    rows.forEach((r, idx) => {
      if (isBlankRow(r)) return;
      const first = cell(r, 0).toLowerCase();
      if (first === 'sl') return void (section = 'register');
      if (first === 'owner') return void (section = 'owners');
      if (section === 'register') register.push([...r, String(idx + 1)]);
      else if (section === 'owners') owners.push({ name: cell(r, 0), shares: Number(cell(r, 1)) });
    });

    owners.forEach((o, i) => {
      const key = `M${String(i + 1).padStart(2, '0')}`;
      ownerKey.set(o.name, key);
      ownerShares.set(key, o.shares);
      const phone = `+88017000000${String(i + 1).padStart(2, '0')}`;
      out.members.push([key, o.name, phone, FUND_START, 'active']);
      flag('Share Holder.csv', i + 1, `phone of ${o.name}`, 'The sheet has no phone numbers; a placeholder was written', phone);
      flag('Share Holder.csv', i + 1, `joined_on of ${o.name}`, 'The sheet has no join date; the Start Boost date was used', FUND_START);
      out.share_holdings.push([key, String(o.shares), FUND_START]);
    });

    const total = owners.reduce((a, o) => a + o.shares, 0);
    if (total !== register.length) {
      flag('Share Holder.csv', '', 'share count', `The owner table adds up to ${total} shares but the register has ${register.length} rows`, String(register.length));
    }
    let owner = 0;
    let usedForOwner = 0;
    register.forEach((r) => {
      while (owner < owners.length && usedForOwner >= (owners[owner] as { shares: number }).shares) {
        owner += 1;
        usedForOwner = 0;
      }
      const o = owners[owner];
      if (!o) return flag('Share Holder.csv', r[r.length - 1] as string, `register row SL ${cell(r, 0)}`, 'No owner left to own this share; row skipped');
      usedForOwner += 1;
      const key = ownerKey.get(o.name) as string;
      out.share_register.push([cell(r, 0), key, cell(r, 1), cell(r, 2), cell(r, 3)]);
    });
  }

  // ---- Collection 26: dues, fines and the expected totals -------------------------------------
  type Status = 'paid' | 'late' | 'unpaid';
  const status = new Map<string, Status>(); // `${key}|${label lower}`
  const expected = new Map<string, { pp: bigint; fp: bigint; po: bigint; fo: bigint }>();
  const dueRows: string[][] = [];
  const fineRows: string[][] = [];
  if (tabs.collection !== undefined) {
    const rows = parseCsv(tabs.collection);
    const names = rows[0] ?? [];
    const header = rows[1] ?? [];
    const blocks: Array<{ col: number; key: string; name: string }> = [];
    header.forEach((h, c) => {
      if (h.trim().toLowerCase() !== 'status') return;
      const name = cell(names, c);
      const key = ownerKey.get(name);
      if (!key) return flag('Collection 26.csv', 1, `member block "${name}"`, 'No owner with this name in the Share Holder tab; block skipped');
      blocks.push({ col: c, key, name });
    });

    for (const b of blocks) expected.set(b.key, { pp: 0n, fp: 0n, po: 0n, fo: 0n });
    rows.slice(2).forEach((r, i) => {
      if (isBlankRow(r)) return;
      const rowNo = i + 3;
      const label = cell(r, 0);
      const lp = labelPeriod(label);
      if (!lp) return flag('Collection 26.csv', rowNo, `row label "${label}"`, 'Not Start Boost or a month name; row skipped');

      const wanted = lp.kind === 'start_boost' ? FUND_START : dateInPeriod(lp.period, 20);
      const written = cell(r, 1);
      if (parseSheetDate(written) !== wanted) {
        flag('Collection 26.csv', rowNo, `due date of ${label}`, `The label says "${written}"; the rule is ${lp.kind === 'monthly' ? 'the 20th' : 'the Start Boost date'}`, wanted);
      }

      for (const b of blocks) {
        const st = cell(r, b.col).toLowerCase();
        if (st === '') continue;
        const parsed: Status | null = st === 'paid' ? 'paid' : st === 'l paid' ? 'late' : st === 'unpaid' ? 'unpaid' : null;
        if (!parsed) {
          flag('Collection 26.csv', rowNo, `status "${st}" of ${b.name}`, 'Expected Paid, L Paid or Unpaid; cell skipped');
          continue;
        }
        const amount = paisa(cell(r, b.col + 2));
        const fine = paisa(cell(r, b.col + 1)) ?? 0n;
        if (amount === null || amount <= 0n) {
          flag('Collection 26.csv', rowNo, `amount of ${b.name} for ${label}`, 'Missing or not a positive amount; cell skipped');
          continue;
        }
        status.set(`${b.key}|${label.toLowerCase()}`, parsed);
        const shares = ownerShares.get(b.key) ?? 1;
        dueRows.push([b.key, lp.period, lp.kind, String(shares), amount.toString(), wanted]);
        const e = expected.get(b.key) as { pp: bigint; fp: bigint; po: bigint; fo: bigint };
        if (parsed === 'unpaid') e.po += amount;
        else e.pp += amount;
        if (fine > 0n) {
          if (parsed === 'paid') flag('Collection 26.csv', rowNo, `fine of ${b.name} for ${label}`, 'A fine is shown on a row marked Paid (on time); it was treated as paid', fine.toString());
          fineRows.push([b.key, lp.period, fine.toString(), parsed === 'unpaid' ? 'unpaid' : 'paid']);
          if (parsed === 'unpaid') e.fo += fine;
          else e.fp += fine;
        }
      }
    });
  }
  const byKeyThenDate = (a: string[], b: string[]): number =>
    (a[0] as string).localeCompare(b[0] as string) || (a[1] as string).localeCompare(b[1] as string);
  out.dues = dueRows.sort(byKeyThenDate);
  out.fines = fineRows.sort(byKeyThenDate);
  out.expected_totals = [...expected]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, e]) => [k, e.pp.toString(), e.fp.toString(), e.po.toString(), e.fo.toString()]);

  // ---- Dashboard: cross-check of the TRUE/FALSE paid flags ------------------------------------
  if (tabs.dashboard !== undefined) {
    const rows = parseCsv(tabs.dashboard).filter((r) => !isBlankRow(r));
    const header = rows[0] ?? [];
    rows.slice(1).forEach((r, i) => {
      const key = ownerKey.get(cell(r, 0));
      if (!key) return;
      header.forEach((label, c) => {
        if (c === 0) return;
        const flagText = cell(r, c).toUpperCase();
        const st = status.get(`${key}|${label.trim().toLowerCase()}`);
        if (!st || (flagText !== 'TRUE' && flagText !== 'FALSE')) return;
        const paid = st !== 'unpaid';
        if (paid !== (flagText === 'TRUE')) {
          flag('Dashboard.csv', i + 2, `${cell(r, 0)} / ${label.trim()}`, `Dashboard says ${flagText} but Collection 26 says ${st === 'unpaid' ? 'Unpaid' : st === 'late' ? 'L Paid' : 'Paid'}`, 'check the sheet');
        }
      });
    });
  }

  // ---- Transection: payments --------------------------------------------------------------------
  if (tabs.transaction !== undefined) {
    const rows = parseCsv(tabs.transaction).filter((r) => !isBlankRow(r));
    interface Group { sl: string; rowNo: number; payer: string; method: string; payFor: string; message: string; paid: bigint; cells: number; extraNotes: string[] }
    const groups: Group[] = [];
    rows.slice(1).forEach((r, i) => {
      const payFor = cell(r, 3);
      const paid = paisa(cell(r, 5));
      const last = groups[groups.length - 1];
      if (payFor === '' && last) {
        // a blank pay-for continues the previous payment (Doc.md 13)
        if (paid !== null) last.paid += paid;
        if (paid !== null) last.cells += 1;
        const extra = cell(r, 7);
        if (extra) last.extraNotes.push(extra);
        return;
      }
      groups.push({ sl: cell(r, 0), rowNo: i + 2, payer: cell(r, 1), method: cell(r, 2), payFor, message: cell(r, 7), paid: paid ?? 0n, cells: paid === null ? 0 : 1, extraNotes: [] });
    });

    const seenTrx = new Map<string, string>();
    for (const g of groups) {
      const key = ownerKey.get(g.payer);
      const file = 'Transection.csv';
      if (!key) {
        flag(file, g.rowNo, `payer "${g.payer}"`, 'No owner with this name; payment skipped');
        continue;
      }
      const sms = parsePaymentSms(g.message);
      const method = normalizeMethod(g.method);
      if (method === 'other') flag(file, g.rowNo, `method "${g.method}"`, 'Not recognised; imported as other', 'other');
      else if (sms.parsed && sms.method !== null && sms.method !== method && !(sms.method === 'bkash' && method === 'cash')) {
        flag(file, g.rowNo, 'method', `The Method column says ${method} but the SMS reads as ${sms.method}`, sms.method);
      }

      let amount: bigint | null = null;
      if (sms.parsed && sms.amount_paisa !== null) {
        amount = sms.amount_paisa;
        if (g.cells > 0 && g.paid !== amount) {
          flag(file, g.rowNo, 'amount', `The SMS says ${amount} paisa but the paid cells add up to ${g.paid}`, amount.toString());
        }
      } else if (g.cells > 0 && g.paid > 0n) {
        amount = g.paid;
      }
      if (amount === null || amount <= 0n) {
        flag(file, g.rowNo, `payment of ${g.payer}`, 'No amount in the SMS and no usable paid cell; payment skipped');
        continue;
      }

      let paidAt = sms.paid_at;
      if (!paidAt) {
        const lp = labelPeriod(g.payFor);
        const day = lp ? (lp.kind === 'start_boost' ? FUND_START : dateInPeriod(lp.period, 20)) : `${YEAR}-01-01`;
        paidAt = `${day}T12:00:00+06:00`;
        flag(file, g.rowNo, `payment date of ${g.payer} for "${g.payFor}"`, 'The message has no date; the due date was used', paidAt);
      }

      const trx = sms.trx_id;
      if (trx) {
        const prior = seenTrx.get(trx);
        if (prior) flag(file, g.rowNo, `TrxID ${trx}`, `Same TrxID as payment ${prior}; the loader will refuse the file until one of them is fixed`);
        else seenTrx.set(trx, `P${g.sl || g.rowNo}`);
      }

      const note = sms.parsed ? '' : [g.message, ...g.extraNotes].filter(Boolean).join('; ');
      out.payments.push([`P${g.sl || g.rowNo}`, key, amount.toString(), method, trx ?? '', paidAt, note, sms.parsed ? g.message : '']);
    }
  }

  // ---- Investments -----------------------------------------------------------------------------
  if (tabs.investments !== undefined) {
    const rows = parseCsv(tabs.investments).filter((r) => !isBlankRow(r));
    let n = 0;
    rows.slice(1).forEach((r, i) => {
      const file = 'Investments.csv';
      const rowNo = i + 2;
      const date = parseSheetDate(cell(r, 0));
      const desc = cell(r, 1);
      const amount = paisa(cell(r, 2));
      if (amount === null || amount <= 0n || !date) return flag(file, rowNo, `row "${desc}"`, 'Missing date or amount; row skipped');
      if (/^profit\b/i.test(desc)) {
        out.misc_ledger.push([date, 'BANK', 'OTHER_INCOME', amount.toString(), `Profit (legacy sheet): ${desc}`, '']);
        return flag(file, rowNo, 'Profit row', 'Booked as OTHER_INCOME into BANK; is it permitted profit or charity money?', 'OTHER_INCOME');
      }
      n += 1;
      const key = `A${String(n).padStart(2, '0')}`;
      const kind = /gold/i.test(desc) ? 'gold' : 'other';
      if (kind === 'other') flag(file, rowNo, `kind of "${desc}"`, 'Not recognised as gold', 'other');
      const done = /^completed?$/i.test(cell(r, 3));
      out.assets.push([key, kind, desc, date, amount.toString(), '', '', done ? 'held' : 'acquiring', 'BANK']);
      if (kind === 'gold') flag(file, rowNo, `quantity and unit of ${key}`, 'The sheet has neither; the asset is created without them', 'vori or gram');
      flag(file, rowNo, `source account of ${key}`, 'The sheet does not say which account paid; BANK was assumed', 'BANK');
    });
  }

  // ---- Miscellaneous ---------------------------------------------------------------------------
  if (tabs.miscellaneous !== undefined) {
    const rows = parseCsv(tabs.miscellaneous).filter((r) => !isBlankRow(r));
    rows.slice(1).forEach((r, i) => {
      const file = 'Miscellaneous.csv';
      const rowNo = i + 2;
      const date = parseSheetDate(cell(r, 0));
      const desc = cell(r, 1);
      const expense = paisa(cell(r, 2));
      const revenue = paisa(cell(r, 3));
      const label = desc || '(no label)';
      if (!desc || !date) return flag(file, rowNo, `row "${label}"`, 'Unlabelled or undated scratch numbers; ignored');
      const add = (debit: string, credit: string, amount: bigint, memo: string): void => {
        out.misc_ledger.push([date, debit, credit, amount.toString(), memo, '']);
      };
      if (expense !== null && expense > 0n) {
        if (/sms/i.test(desc)) add('SMS_CHARGE', 'BANK', expense, desc);
        else if (/bank|charge|fee/i.test(desc)) add('BANK_CHARGE', 'BANK', expense, desc);
        else {
          add('OTHER_EXPENSE', 'BANK', expense, desc);
          flag(file, rowNo, `expense "${desc}"`, 'Not a bank or SMS charge; booked as OTHER_EXPENSE (spending needs an approved proposal)', 'OTHER_EXPENSE');
        }
        return;
      }
      if (revenue === null || revenue === 0n) return flag(file, rowNo, `row "${desc}"`, 'No amount; ignored');
      if (revenue < 0n) {
        if (/distribut/i.test(desc)) {
          add('DISTRIBUTIONS', 'BANK', -revenue, desc);
          return flag(file, rowNo, `distribution "${desc}"`, 'A negative revenue labelled as a distribution; booked as DISTRIBUTIONS paid from BANK', 'DISTRIBUTIONS');
        }
        return flag(file, rowNo, `negative row "${desc}"`, 'A negative number that is not a distribution; ignored');
      }
      if (/fine/i.test(desc)) return flag(file, rowNo, `row "${desc}"`, 'Fine totals are not imported; fines come from the payments', '');
      if (/interest/i.test(desc)) {
        add('BANK', 'CHARITY_PAYABLE', revenue, desc);
        return flag(file, rowNo, `bank interest "${desc}"`, 'Interest is charity money (18.2): posted to CHARITY_PAYABLE, not BANK_INTEREST', 'CHARITY_PAYABLE');
      }
      add('BANK', 'OTHER_INCOME', revenue, desc);
      flag(file, rowNo, `revenue "${desc}"`, 'Unclassified revenue; booked as OTHER_INCOME into BANK', 'OTHER_INCOME');
    });
  }

  // ---- Opening balances ------------------------------------------------------------------------
  if (tabs.openingBalances !== undefined) {
    const rows = parseCsv(tabs.openingBalances).filter((r) => !isBlankRow(r));
    rows.slice(1).forEach((r, i) => {
      const account = cell(r, 0).toUpperCase().replace(/\s+/g, '');
      const balance = paisa(cell(r, 1));
      const asOf = parseSheetDate(cell(r, 2));
      if (!['CASH', 'BANK', 'BKASH', 'NAGAD'].includes(account) || balance === null || !asOf) {
        return flag('Opening Balances.csv', i + 2, `row "${cell(r, 0)}"`, 'Unknown account, amount or date; row skipped');
      }
      out.opening_balances.push([account, balance.toString(), asOf]);
    });
  }

  const files = Object.fromEntries(
    (Object.keys(FILES) as NormalizedName[]).map((name) => [FILES[name].file, toCsv(FILES[name].columns, out[name])]),
  );
  // keyed by normalized name for callers; file names are available through FILES
  const byName = Object.fromEntries(
    (Object.keys(FILES) as NormalizedName[]).map((name) => [name, files[FILES[name].file] as string]),
  ) as Record<NormalizedName, string>;
  return { files: byName, review };
}

export function reviewCsv(review: readonly ReviewRow[]): string {
  return toCsv(REVIEW_COLUMNS, review.map((r) => [r.file, r.row, r.what, r.why, r.suggested]));
}
