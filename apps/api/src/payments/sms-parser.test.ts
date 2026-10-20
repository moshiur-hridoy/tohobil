import { describe, expect, it } from 'vitest';
import { parsePaymentSms } from './sms-parser';

describe('parsePaymentSms', () => {
  it('reads a bKash receive message', () => {
    const r = parsePaymentSms(
      'You have received Tk 17,500.00 from 01700000000. Fee Tk 0.00. Balance Tk 38,486.45. TrxID AB12CD34EF at 30/12/2025 22:00',
    );
    expect(r).toEqual({
      parsed: true,
      method: 'bkash',
      amount_paisa: 1_750_000n,
      trx_id: 'AB12CD34EF',
      paid_at: '2025-12-30T22:00:00+06:00',
      counterparty_phone: '+8801700000000',
      balance_paisa: 3_848_645n,
    });
  });

  it('reads a bKash cash-in message with a trailing full stop', () => {
    const r = parsePaymentSms(
      'Cash In Tk 20,400.00 from 01700000000 successful. Fee Tk 0.00. Balance Tk 20,437.81. TrxID ab12cd34ef at 15/01/2026 19:23.',
    );
    expect(r.parsed).toBe(true);
    expect(r.method).toBe('bkash');
    expect(r.amount_paisa).toBe(2_040_000n);
    expect(r.trx_id).toBe('AB12CD34EF'); // upper-cased: TrxIDs are compared case-insensitively
    expect(r.paid_at).toBe('2026-01-15T19:23:00+06:00');
    expect(r.balance_paisa).toBe(2_043_781n);
  });

  it('reads a bank deposit: amount and date only, no TrxID', () => {
    const r = parsePaymentSms(
      '28-Dec-2025 Tk. 15,500 Deposit Tk. 65,655 Balance A/C: 1781***3544',
    );
    expect(r).toEqual({
      parsed: true,
      method: 'bank',
      amount_paisa: 1_550_000n,
      trx_id: null,
      paid_at: '2025-12-28T12:00:00+06:00',
      counterparty_phone: null,
      balance_paisa: 6_565_500n,
    });
  });

  it('tags a Nagad message as nagad and tolerates line breaks', () => {
    const r = parsePaymentSms(
      'Nagad\nYou have received Tk 500.00 from 01800000000.\nTrxID: 7ABCD1234 at 02/02/2026 10:05',
    );
    expect(r.method).toBe('nagad');
    expect(r.amount_paisa).toBe(50_000n);
    expect(r.trx_id).toBe('7ABCD1234');
  });

  it('never throws and returns nulls for text it does not understand', () => {
    for (const text of ['', '   ', 'hello', 'Tk Tk Tk', 'You have received Tk abc from x', '\u0000\u0001']) {
      expect(parsePaymentSms(text)).toEqual({
        parsed: false,
        method: null,
        amount_paisa: null,
        trx_id: null,
        paid_at: null,
        counterparty_phone: null,
        balance_paisa: null,
      });
    }
  });

  it('rejects an impossible date but keeps the rest', () => {
    const r = parsePaymentSms(
      'You have received Tk 100.00 from 01700000000. TrxID ZZ99YY88XX at 31/02/2026 10:00',
    );
    expect(r.parsed).toBe(true);
    expect(r.paid_at).toBeNull();
  });
});
