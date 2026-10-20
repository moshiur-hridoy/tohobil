import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CODES,
  CASH_ACCOUNT_CODES,
  NAV_CASH_ACCOUNTS,
  NAV_DEDUCTION_ACCOUNTS,
  NAV_REPLACED_BY_VALUATION_ACCOUNT,
} from './enums';
import { auditLogQuerySchema, ledgerQuerySchema } from './schemas/ledger';
import { fileViewQuerySchema, FILE_ALLOWED_MIMES, FILE_MAX_BYTES } from './schemas/file';

describe('NAV exclusions (spec 5.7 as amended by 18.2, 18.4, 19.2)', () => {
  it('deducts exactly the accounts that are owed to someone, per 18.4', () => {
    expect([...NAV_DEDUCTION_ACCOUNTS].sort()).toEqual(
      [
        'SETTLEMENT_PAYABLE',
        'MEMBER_ESCROW',
        'CHARITY_PAYABLE',
        'LEVY_CLEARING',
        'INACTIVE_HELD',
        'MEMBER_QARD',
        'DEFERRED_PURCHASE_PAYABLE',
      ].sort(),
    );
  });

  it('charity money (fines, absence fines, interest) is deducted, so it never raises NAV', () => {
    expect(NAV_DEDUCTION_ACCOUNTS).toContain('CHARITY_PAYABLE');
  });

  it('only the four cash accounts count as cash, and nothing is both counted and deducted', () => {
    expect([...NAV_CASH_ACCOUNTS]).toEqual([...CASH_ACCOUNT_CODES]);
    for (const account of NAV_DEDUCTION_ACCOUNTS) {
      expect(NAV_CASH_ACCOUNTS as readonly string[]).not.toContain(account);
      expect(ACCOUNT_CODES as readonly string[]).toContain(account);
    }
  });

  it('investments at cost are replaced by valuations, not counted directly', () => {
    expect(NAV_REPLACED_BY_VALUATION_ACCOUNT).toBe('INVESTMENTS_AT_COST');
    expect(NAV_DEDUCTION_ACCOUNTS as readonly string[]).not.toContain(
      NAV_REPLACED_BY_VALUATION_ACCOUNT,
    );
    expect(NAV_CASH_ACCOUNTS as readonly string[]).not.toContain(NAV_REPLACED_BY_VALUATION_ACCOUNT);
  });
});

describe('ledger and audit-log query schemas', () => {
  it('default to newest first, 50 rows', () => {
    expect(ledgerQuerySchema.parse({})).toMatchObject({ order: 'desc', limit: 50 });
    expect(auditLogQuerySchema.parse({})).toMatchObject({ limit: 50 });
  });

  it('accept filters and coerce the limit from the query string', () => {
    const parsed = ledgerQuerySchema.parse({
      from: '2026-10-01',
      to: '2026-10-31',
      account: 'CHARITY_PAYABLE',
      ref_type: 'payment_reversal',
      order: 'asc',
      limit: '200',
    });
    expect(parsed).toMatchObject({ account: 'CHARITY_PAYABLE', order: 'asc', limit: 200 });
  });

  it('reject unknown accounts, impossible dates, bad reference types and oversized pages', () => {
    for (const bad of [
      { account: 'PETTY_CASH' },
      { from: '2026-02-30' },
      { ref_type: 'Bad-Type' },
      { member_id: 'abc' },
      { order: 'sideways' },
      { limit: '201' },
      { limit: '0' },
    ]) {
      expect(ledgerQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(auditLogQuerySchema.safeParse({ to: 'tomorrow' }).success).toBe(false);
  });
});

describe('file limits', () => {
  it('match the spec: 10 MB, images and PDF', () => {
    expect(FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect([...FILE_ALLOWED_MIMES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
  });

  it('thumb is a real boolean: the text "false" is false', () => {
    expect(fileViewQuerySchema.parse({ thumb: 'true' }).thumb).toBe(true);
    expect(fileViewQuerySchema.parse({ thumb: 'false' }).thumb).toBe(false);
    expect(fileViewQuerySchema.parse({}).thumb).toBeUndefined();
    expect(fileViewQuerySchema.safeParse({ thumb: '1' }).success).toBe(false);
  });
});
