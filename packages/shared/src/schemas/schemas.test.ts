import { describe, it, expect } from 'vitest';
import {
  activateSchema,
  cashierEntrySchema,
  isValidPin,
  normalizeActivationCode,
  paginationSchema,
  paymentSubmitSchema,
  paisaStringSchema,
  periodSchema,
  dateSchema,
  PROPOSAL_PAYLOAD_SCHEMAS,
  validateProposalPayload,
  charityDonationPayloadSchema,
  memberRefSchema,
} from './index';
import { PROPOSAL_TYPES } from '../enums';

describe('money on the wire', () => {
  it('parses a digit string into a bigint', () => {
    const r = paymentSubmitSchema.parse({ amount_paisa: '500000', method: 'cash' });
    expect(r.amount_paisa).toBe(500000n);
  });

  it('rejects JSON numbers, floats, negatives and zero', () => {
    for (const bad of [500000, '5000.50', '-1', '0', '', '1e6', 'abc', '1'.repeat(19)]) {
      expect(
        paymentSubmitSchema.safeParse({ amount_paisa: bad, method: 'cash' }).success,
        String(bad),
      ).toBe(false);
    }
  });

  it('payload money stays a string so it can be stored as jsonb', () => {
    expect(paisaStringSchema.parse('10000000')).toBe('10000000');
    expect(paisaStringSchema.safeParse('0').success).toBe(false);
    expect(paisaStringSchema.safeParse('010').success).toBe(false);
  });
});

describe('payment submission', () => {
  it('requires a TrxID for bKash/Nagad/Bank but not cash', () => {
    expect(paymentSubmitSchema.safeParse({ amount_paisa: '100', method: 'bkash' }).success).toBe(
      false,
    );
    expect(paymentSubmitSchema.safeParse({ amount_paisa: '100', method: 'bank' }).success).toBe(
      false,
    );
    expect(paymentSubmitSchema.safeParse({ amount_paisa: '100', method: 'cash' }).success).toBe(
      true,
    );
    expect(
      paymentSubmitSchema.safeParse({ amount_paisa: '100', method: 'bkash', trx_id: 'AB12CD34EF' })
        .success,
    ).toBe(true);
  });

  it('has no member_id: the payer is the authenticated member', () => {
    const r = paymentSubmitSchema.parse({
      amount_paisa: '100',
      method: 'cash',
      member_id: '00000000-0000-0000-0000-000000000001',
    });
    expect('member_id' in r).toBe(false);
  });

  it('accepts timestamps with a UTC offset (Bangladesh clients send +06:00)', () => {
    expect(
      paymentSubmitSchema.safeParse({
        amount_paisa: '100',
        method: 'cash',
        paid_at: '2026-01-20T10:00:00+06:00',
      }).success,
    ).toBe(true);
  });
});

describe('cashier entry allocations', () => {
  const base = {
    member_id: '00000000-0000-0000-0000-000000000001',
    amount_paisa: '1000',
    method: 'cash',
    paid_at: '2026-01-20T10:00:00Z',
  };
  const due = '00000000-0000-0000-0000-0000000000d1';
  const fine = '00000000-0000-0000-0000-0000000000f1';

  it('rejects allocations exceeding the payment', () => {
    const r = cashierEntrySchema.safeParse({
      ...base,
      allocations: [
        { due_id: due, amount_paisa: '800' },
        { fine_id: fine, amount_paisa: '300' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts allocations within the payment and requires exactly one target each', () => {
    expect(
      cashierEntrySchema.safeParse({
        ...base,
        allocations: [
          { due_id: due, amount_paisa: '800' },
          { fine_id: fine, amount_paisa: '200' },
        ],
      }).success,
    ).toBe(true);
    expect(
      cashierEntrySchema.safeParse({ ...base, allocations: [{ amount_paisa: '100' }] }).success,
    ).toBe(false);
    expect(
      cashierEntrySchema.safeParse({
        ...base,
        allocations: [{ due_id: due, fine_id: fine, amount_paisa: '100' }],
      }).success,
    ).toBe(false);
  });
});

describe('PIN rules (19.1)', () => {
  it('rejects the deny list, repeated digits and simple sequences', () => {
    for (const bad of [
      '000000',
      '123456',
      '654321',
      '111111',
      '999999',
      '890123',
      '321098',
      '121212',
    ]) {
      expect(isValidPin(bad), bad).toBe(false);
    }
  });
  it('accepts ordinary PINs and enforces six digits', () => {
    expect(isValidPin('492018')).toBe(true);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('12345a')).toBe(false);
  });
});

describe('activation (19.1)', () => {
  const device = { platform: 'android', install_id: 'abc' };
  it('normalises Crockford confusions, case and separators', () => {
    expect(normalizeActivationCode('ab12-cdoi')).toBe('AB12CD01');
    const r = activateSchema.parse({ member_ref: 'm03', code: 'ab12 cd34', device, pin: '492018' });
    expect(r.member_ref).toBe('M03');
    expect(r.code).toBe('AB12CD34');
  });
  it('rejects bad codes, member refs and weak PINs', () => {
    const ok = { member_ref: 'M03', code: 'AB12CD34', device, pin: '492018' };
    expect(activateSchema.safeParse(ok).success).toBe(true);
    expect(activateSchema.safeParse({ ...ok, code: 'AB12CD3' }).success).toBe(false);
    expect(activateSchema.safeParse({ ...ok, code: 'AB12CD3U' }).success).toBe(false); // U is not Crockford
    expect(activateSchema.safeParse({ ...ok, member_ref: 'X03' }).success).toBe(false);
    expect(activateSchema.safeParse({ ...ok, pin: '123456' }).success).toBe(false);
  });
  it('memberRefSchema trims and upper-cases', () => {
    expect(memberRefSchema.parse(' m07 ')).toBe('M07');
  });
});

describe('common schemas', () => {
  it('pagination coerces query strings and caps the limit at 200', () => {
    expect(paginationSchema.parse({ limit: '25' }).limit).toBe(25);
    expect(paginationSchema.parse({}).limit).toBe(50);
    expect(paginationSchema.safeParse({ limit: '201' }).success).toBe(false);
  });
  it('period and date reject impossible values', () => {
    expect(periodSchema.safeParse('2026-12').success).toBe(true);
    expect(periodSchema.safeParse('2026-13').success).toBe(false);
    expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(dateSchema.safeParse('2026-02-28').success).toBe(true);
  });
});

describe('proposal payload registry', () => {
  it('has a payload schema for every proposal type', () => {
    for (const type of PROPOSAL_TYPES) {
      expect(PROPOSAL_PAYLOAD_SCHEMAS[type], type).toBeDefined();
    }
  });

  it('validates by type', () => {
    expect(validateProposalPayload('general', { text: 'Meet on Friday' }).success).toBe(true);
    expect(validateProposalPayload('general', {}).success).toBe(false);
    expect(
      validateProposalPayload('expense', {
        max_amount_paisa: '500000',
        account: 'MAINTENANCE',
        payee: 'Plumber',
        purpose: 'Fix pipe',
      }).success,
    ).toBe(true);
    expect(
      validateProposalPayload('expense', {
        max_amount_paisa: 500000, // a number would lose the "no floats" guarantee
        account: 'MAINTENANCE',
        payee: 'Plumber',
        purpose: 'Fix pipe',
      }).success,
    ).toBe(false);
  });

  it('charity donation payload has no proof file: the receipt exists only after the donation', () => {
    const r = charityDonationPayloadSchema.parse({
      recipient: 'Orphanage',
      amount_paisa: '100000',
      purpose: 'Year-end zakat-ul-fitr',
    });
    expect('proof_file_id' in r).toBe(false);
  });
});
