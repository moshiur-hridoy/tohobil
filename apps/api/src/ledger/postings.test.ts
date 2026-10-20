import { describe, expect, it } from 'vitest';
import { autoChargePosting, paymentPostings, ribaReceivedPosting } from './postings';

const base = {
  entryDate: '2026-11-04',
  memberId: '11111111-1111-1111-1111-111111111111',
  paymentId: '22222222-2222-2222-2222-222222222222',
};

describe('paymentPostings (spec 5.4 with the charity routing of 18.2)', () => {
  it('splits a payment into principal, credit and fine, one entry per non-zero part', () => {
    const entries = paymentPostings({
      ...base,
      method: 'bkash',
      principalPaisa: 500_000n,
      creditPaisa: 100_000n,
      finePaisa: 50_000n,
    });
    expect(entries.map((e) => [e.memo, e.debit, e.credit, e.amount_paisa])).toEqual([
      ['principal', 'BKASH', 'MEMBER_CAPITAL', 500_000n],
      ['credit', 'BKASH', 'MEMBER_CAPITAL', 100_000n],
      ['fine', 'BKASH', 'CHARITY_PAYABLE', 50_000n],
    ]);
    for (const e of entries) {
      expect(e).toMatchObject({
        ref_type: 'payment',
        ref_id: base.paymentId,
        member_id: base.memberId,
        entry_date: '2026-11-04',
      });
    }
  });

  it('never routes a fine to income: FINE_INCOME appears nowhere', () => {
    const entries = paymentPostings({
      ...base,
      method: 'cash',
      principalPaisa: 0n,
      creditPaisa: 0n,
      finePaisa: 200_000n,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ debit: 'CASH', credit: 'CHARITY_PAYABLE' });
    expect(
      JSON.stringify(entries, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain('FINE_INCOME');
  });

  it('skips zero parts and the parts always add up to the payment', () => {
    const entries = paymentPostings({
      ...base,
      method: 'nagad',
      principalPaisa: 1_234n,
      creditPaisa: 0n,
      finePaisa: 0n,
    });
    expect(entries).toHaveLength(1);
    expect(entries.reduce((s, e) => s + e.amount_paisa, 0n)).toBe(1_234n);
  });

  it('posts to the cash account of the method; `other` goes to BANK', () => {
    const debit = (method: 'bkash' | 'nagad' | 'bank' | 'cash' | 'other') =>
      paymentPostings({ ...base, method, principalPaisa: 1n, creditPaisa: 0n, finePaisa: 0n })[0]
        ?.debit;
    expect(['bkash', 'nagad', 'bank', 'cash', 'other'].map((m) => debit(m as 'bkash'))).toEqual([
      'BKASH',
      'NAGAD',
      'BANK',
      'CASH',
      'BANK',
    ]);
  });

  it('refuses an empty or negative payment', () => {
    const zero = {
      ...base,
      method: 'cash' as const,
      principalPaisa: 0n,
      creditPaisa: 0n,
      finePaisa: 0n,
    };
    expect(() => paymentPostings(zero)).toThrow(/positive amount/);
    expect(() => paymentPostings({ ...zero, principalPaisa: 10n, finePaisa: -1n })).toThrow(
      /negative/,
    );
  });
});

describe('other standard postings', () => {
  it('interest that arrives in the bank is charity money, not income', () => {
    expect(ribaReceivedPosting({ entryDate: '2026-12-31', amountPaisa: 4_200n })).toMatchObject({
      debit: 'BANK',
      credit: 'CHARITY_PAYABLE',
      amount_paisa: 4_200n,
      ref_type: 'riba_received',
      member_id: null,
    });
  });

  it('a bank or SMS charge is tagged auto_charge so the auditor can list it', () => {
    expect(
      autoChargePosting({
        entryDate: '2026-11-04',
        charge: 'BANK_CHARGE',
        paidFrom: 'BANK',
        amountPaisa: 5_000n,
      }),
    ).toMatchObject({ debit: 'BANK_CHARGE', credit: 'BANK', ref_type: 'auto_charge' });
    expect(
      autoChargePosting({
        entryDate: '2026-11-04',
        charge: 'SMS_CHARGE',
        paidFrom: 'BKASH',
        amountPaisa: 100n,
      }),
    ).toMatchObject({ debit: 'SMS_CHARGE', credit: 'BKASH', ref_type: 'auto_charge' });
  });
});
