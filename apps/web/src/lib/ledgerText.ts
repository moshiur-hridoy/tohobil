import type { TFunction } from 'i18next';
import { ACCOUNT_CODES, CASH_ACCOUNT_CODES } from '@barakah/shared';
import { fmtPeriod } from './dates';
import { formatCount, localDigits } from './format';

/**
 * Ledger entries in plain words. The stored codes and memos never change (they are part of the hash
 * chain); only how they are shown. Codes stay in the CSV export and in a tooltip for the cashier.
 */

type Code = (typeof ACCOUNT_CODES)[number];

/** The account picker, grouped the way a member thinks about the money. */
export const ACCOUNT_GROUPS: ReadonlyArray<{ id: string; codes: readonly Code[] }> = [
  { id: 'money', codes: ['CASH', 'BANK', 'BKASH', 'NAGAD', 'INVESTMENTS_AT_COST'] },
  {
    id: 'members',
    codes: ['MEMBER_CAPITAL', 'LEVY_CLEARING', 'CHARITY_PAYABLE', 'SETTLEMENT_PAYABLE', 'MEMBER_ESCROW', 'INACTIVE_HELD', 'MEMBER_QARD', 'DEFERRED_PURCHASE_PAYABLE', 'OPENING_ADJUSTMENT'],
  },
  { id: 'income', codes: ['RENT_INCOME', 'BANK_PROFIT', 'ASSET_GAIN', 'OTHER_INCOME', 'EXIT_FEE_INCOME', 'FINE_INCOME'] },
  { id: 'expense', codes: ['BANK_CHARGE', 'SMS_CHARGE', 'MAINTENANCE', 'ASSET_LOSS', 'OTHER_EXPENSE', 'DISTRIBUTIONS'] },
];

const CASH = new Set<string>(CASH_ACCOUNT_CODES);
const EXPENSE = new Set<string>(['BANK_CHARGE', 'SMS_CHARGE', 'MAINTENANCE', 'ASSET_LOSS', 'OTHER_EXPENSE']);
const INCOME = new Set<string>(['RENT_INCOME', 'BANK_PROFIT', 'ASSET_GAIN', 'OTHER_INCOME', 'EXIT_FEE_INCOME', 'FINE_INCOME']);

export const accountName = (t: TFunction, code: string): string => t(`accountName.${code}`, { defaultValue: code });

export interface EntryLike {
  debit_account: string;
  credit_account: string;
  ref_type: string | null;
  memo: string | null;
  reverses_seq: string | null;
}

/** A short title for what the entry was, read from its two accounts (debit is where the money went). */
export function entryTitle(t: TFunction, r: EntryLike): string {
  const d = r.debit_account;
  const c = r.credit_account;
  const k = (key: string, opts?: Record<string, string>) => t(`ledgerEntry.${key}`, opts);
  if (r.reverses_seq) return k('reversal');
  if (c === 'MEMBER_CAPITAL' && CASH.has(d)) return r.memo === 'credit' ? k('memberAdvance') : k('memberDeposit');
  if (c === 'CHARITY_PAYABLE') {
    if (r.ref_type === 'riba_received') return k('ribaToCharity');
    if (r.memo === 'fine' || r.ref_type === 'payment') return k('fineToCharity');
    return k('toCharity');
  }
  if (d === 'CHARITY_PAYABLE' && CASH.has(c)) return k('charityDonation');
  if (c === 'LEVY_CLEARING' && CASH.has(d)) return k('levyIn');
  if (d === 'LEVY_CLEARING' && EXPENSE.has(c)) return k('levyMoved');
  if (EXPENSE.has(d) && c === 'LEVY_CLEARING') return k('levyExpense', { name: accountName(t, d) });
  if (EXPENSE.has(d)) return accountName(t, d);
  if (d === 'INVESTMENTS_AT_COST') return k('investmentBuy');
  if (c === 'INVESTMENTS_AT_COST') return k('investmentOut');
  if (d === 'DISTRIBUTIONS') return accountName(t, d);
  if (c === 'SETTLEMENT_PAYABLE') return k('settlement');
  if (d === 'SETTLEMENT_PAYABLE') return k('settlementPayout');
  if (d === 'MEMBER_ESCROW') return k('escrowPayout');
  if (c === 'INACTIVE_HELD') return k('inactiveHeld');
  if (c === 'MEMBER_QARD') return k('qardIn');
  if (d === 'MEMBER_QARD') return k('qardOut');
  if (d === 'DEFERRED_PURCHASE_PAYABLE') return k('deferredInstalment');
  if (d === 'OPENING_ADJUSTMENT' || c === 'OPENING_ADJUSTMENT') return accountName(t, 'OPENING_ADJUSTMENT');
  if (INCOME.has(c)) return accountName(t, c);
  if (CASH.has(d) && CASH.has(c)) return k('transfer');
  return k('other');
}

/** Memos the system writes for itself that say nothing the title does not. */
const SILENT_MEMOS = new Set(['principal', 'credit', 'fine', 'Deferred purchase instalment']);
const LEGACY = ' (legacy import)';

/**
 * The memo in words: machine words are dropped, the few sentences the system writes in English are
 * said in the reader's language, and anything a person typed is shown as it is.
 */
export function memoText(t: TFunction, memo: string | null): string | null {
  if (!memo) return null;
  const m = memo.trim();
  if (SILENT_MEMOS.has(m) || m.startsWith('Settlement') || m.startsWith('Member left the fund')) return null;
  if (m.endsWith(LEGACY)) {
    const inner = memoText(t, m.slice(0, -LEGACY.length));
    return inner ? `${inner} · ${t('ledgerEntry.legacy')}` : t('ledgerEntry.legacy');
  }
  let match = /^Reversal of #(\d+): ([\s\S]*)$/.exec(m);
  if (match) return t('ledgerEntry.memoReversal', { seq: localDigits(match[1]!), reason: match[2] });
  match = /^Moved to the levy fund: entry #(\d+)(?: \(([\s\S]*)\))?$/.exec(m);
  if (match) {
    const head = t('ledgerEntry.memoLevyMoved', { seq: localDigits(match[1]!) });
    const inner = match[2] ? memoText(t, match[2]) : null;
    return inner ? `${head} (${inner})` : head;
  }
  match = /^Distribution by shares \((\d+)\)$/.exec(m);
  if (match) return t('ledgerEntry.memoDistribution', { n: formatCount(Number(match[1])) });
  match = /^Rent (\d{4}-\d{2})$/.exec(m);
  if (match) return t('ledgerEntry.memoRent', { period: fmtPeriod(match[1]!) });
  match = /^Asset \S+ ([\s\S]+)$/.exec(m);
  if (match) return match[1]!;
  match = /^Levy fund, [^:]+: ([\s\S]*)$/.exec(m);
  if (match) return match[1]!;
  match = /^([\s\S]+): (proceeds|gain|loss|cost recovery)$/.exec(m);
  if (match) {
    const key = { proceeds: 'assetProceeds', gain: 'assetGain', loss: 'assetLoss', 'cost recovery': 'assetCost' }[match[2]!]!;
    return t(`ledgerEntry.${key}`, { label: match[1] });
  }
  return m;
}
