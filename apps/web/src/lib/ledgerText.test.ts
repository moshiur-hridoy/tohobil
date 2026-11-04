import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CODES } from '@barakah/shared';
import bn from '../../../../packages/shared/src/i18n/bn.json';
import { localDigits } from './format';
import { ACCOUNT_GROUPS, entryTitle, memoText, type EntryLike } from './ledgerText';

/** Returns the key, with any interpolated values after it, so the tests read which text was chosen. */
const t = ((key: string, opts?: Record<string, unknown>) => {
  const vars = Object.entries(opts ?? {}).filter(([k]) => k !== 'defaultValue');
  return vars.length ? `${key}(${vars.map(([, v]) => String(v)).join(',')})` : key;
}) as unknown as TFunction;

const entry = (debit: string, credit: string, extra: Partial<EntryLike> = {}): EntryLike => ({
  debit_account: debit,
  credit_account: credit,
  ref_type: null,
  memo: null,
  reverses_seq: null,
  ...extra,
});

describe('entryTitle', () => {
  it('names the common entries in plain words', () => {
    expect(entryTitle(t, entry('BANK', 'MEMBER_CAPITAL', { ref_type: 'payment', memo: 'principal' }))).toBe('ledgerEntry.memberDeposit');
    expect(entryTitle(t, entry('BANK', 'MEMBER_CAPITAL', { ref_type: 'payment', memo: 'credit' }))).toBe('ledgerEntry.memberAdvance');
    expect(entryTitle(t, entry('BKASH', 'CHARITY_PAYABLE', { ref_type: 'payment', memo: 'fine' }))).toBe('ledgerEntry.fineToCharity');
    expect(entryTitle(t, entry('LEVY_CLEARING', 'SMS_CHARGE', { ref_type: 'levy_moved' }))).toBe('ledgerEntry.levyMoved');
    expect(entryTitle(t, entry('SMS_CHARGE', 'LEVY_CLEARING'))).toBe('ledgerEntry.levyExpense(accountName.SMS_CHARGE)');
    expect(entryTitle(t, entry('BANK_CHARGE', 'BANK'))).toBe('accountName.BANK_CHARGE');
    expect(entryTitle(t, entry('INVESTMENTS_AT_COST', 'BANK'))).toBe('ledgerEntry.investmentBuy');
    expect(entryTitle(t, entry('CASH', 'BANK'))).toBe('ledgerEntry.transfer');
  });

  it('calls any reversal a reversal, whatever its accounts', () => {
    expect(entryTitle(t, entry('MEMBER_CAPITAL', 'BANK', { reverses_seq: '12' }))).toBe('ledgerEntry.reversal');
  });
});

describe('memoText', () => {
  it('drops the words the system writes for itself', () => {
    expect(memoText(t, 'principal')).toBeNull();
    expect(memoText(t, 'Settlement early_exit capital')).toBeNull();
    expect(memoText(t, null)).toBeNull();
  });

  it('says the system sentences in words, including old-sheet imports', () => {
    expect(memoText(t, 'Reversal of #42: wrong member')).toBe(`ledgerEntry.memoReversal(${localDigits('42')},wrong member)`);
    expect(memoText(t, 'Moved to the levy fund: entry #130 (Bank Account SMS Charge (legacy import))')).toBe(
      `ledgerEntry.memoLevyMoved(${localDigits('130')}) (Bank Account SMS Charge · ledgerEntry.legacy)`,
    );
    expect(memoText(t, 'Shop A: gain')).toBe('ledgerEntry.assetGain(Shop A)');
  });

  it('keeps what a person typed as it is', () => {
    expect(memoText(t, 'Cheque 0042 to the shop')).toBe('Cheque 0042 to the shop');
  });
});

describe('account names', () => {
  it('every account is in exactly one picker group and has a Bengali name', () => {
    const grouped = ACCOUNT_GROUPS.flatMap((g) => g.codes);
    expect([...grouped].sort()).toEqual([...ACCOUNT_CODES].sort());
    for (const code of ACCOUNT_CODES) expect((bn.accountName as Record<string, string>)[code]).toBeTruthy();
  });
});

describe('memoText for distributions and rent', () => {
  it('says them in words', () => {
    expect(memoText(t, 'Distribution by shares (4)')).toMatch(/^ledgerEntry\.memoDistribution\(/);
    expect(memoText(t, 'Rent 2026-10')).toMatch(/^ledgerEntry\.memoRent\(/);
  });
});
