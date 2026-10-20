import {
  parseDDMMYYYY,
  parseDDMonYYYY,
  tryParseBDT,
  type PaymentMethod,
} from '@barakah/shared';

/**
 * Parser for the payment SMS the cashier pastes (spec 5.4). It only SUGGESTS: a human confirms.
 * It never throws; text it does not understand gives `parsed: false` and nulls.
 *
 * Supported shapes (fake numbers):
 *   bKash receive: "You have received Tk 17,500.00 from 01700000000. Fee Tk 0.00. Balance Tk 38,486.45.
 *                   TrxID AB12CD34EF at 30/12/2025 22:00"
 *   bKash cash in: "Cash In Tk 20,400.00 from 01700000000 successful. Fee Tk 0.00. Balance Tk 20,437.81.
 *                   TrxID AB12CD34EF at 15/01/2026 19:23."
 *   Bank deposit:  "28-Dec-2025 Tk. 15,500 Deposit Tk. 65,655 Balance A/C: 1781***3544"
 *   Nagad receive: the same wording as bKash receive with "Nagad" in the text (see ASSUMPTIONS 60).
 *
 * Times in the SMS are Asia/Dhaka (+06:00). A date without a time (bank) becomes noon Dhaka time, so
 * the date cannot slip across midnight in any conversion.
 */

export interface ParsedSms {
  parsed: boolean;
  method: PaymentMethod | null;
  amount_paisa: bigint | null;
  trx_id: string | null;
  /** ISO timestamp with the +06:00 offset. */
  paid_at: string | null;
  counterparty_phone: string | null;
  balance_paisa: bigint | null;
}

const EMPTY: ParsedSms = {
  parsed: false,
  method: null,
  amount_paisa: null,
  trx_id: null,
  paid_at: null,
  counterparty_phone: null,
  balance_paisa: null,
};

const AMOUNT = String.raw`(?:Tk\.?|৳)\s*([\d,]+(?:\.\d{1,2})?)`;

function amountAfter(text: string, label: string): bigint | null {
  const m = new RegExp(`${label}\\s*${AMOUNT}`, 'i').exec(text);
  return m ? tryParseBDT(m[1] as string) : null;
}

/** `01700000000` (or +8801700000000) to `+8801700000000`. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (/^01[3-9]\d{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}

function dhakaTimestamp(date: string, time: string): string {
  return `${date}T${time}:00+06:00`;
}

function wallet(text: string, method: 'bkash' | 'nagad'): ParsedSms | null {
  const received = new RegExp(`received\\s*${AMOUNT}\\s*from\\s*(\\+?[\\d]{11,14})`, 'i').exec(text);
  const cashIn = new RegExp(`cash\\s*in\\s*${AMOUNT}\\s*from\\s*(\\+?[\\d]{11,14})`, 'i').exec(text);
  const hit = received ?? cashIn;
  if (!hit) return null;

  const amount = tryParseBDT(hit[1] as string);
  if (amount === null || amount <= 0n) return null;

  const trx = /(?:TrxID|TxnID|Trx\s*ID)[:\s]*([A-Za-z0-9]{6,20})/i.exec(text);
  const when = /\bat\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/i.exec(text);
  const date = when ? parseDDMMYYYY(when[1] as string) : null;

  return {
    parsed: true,
    method,
    amount_paisa: amount,
    trx_id: trx ? (trx[1] as string).toUpperCase() : null,
    paid_at: date && when ? dhakaTimestamp(date, when[2] as string) : null,
    counterparty_phone: normalizePhone(hit[2] as string),
    balance_paisa: amountAfter(text, 'Balance'),
  };
}

function bankDeposit(text: string): ParsedSms | null {
  // "<date> Tk. <amount> Deposit Tk. <balance> Balance A/C: ..."
  const m = new RegExp(
    `(\\d{2}-[A-Za-z]{3}-\\d{4})\\s+${AMOUNT}\\s+Deposit(?:\\s+${AMOUNT}\\s+Balance)?`,
    'i',
  ).exec(text);
  if (!m) return null;
  const amount = tryParseBDT(m[2] as string);
  if (amount === null || amount <= 0n) return null;
  const date = parseDDMonYYYY(m[1] as string);
  return {
    parsed: true,
    method: 'bank',
    amount_paisa: amount,
    trx_id: null,
    paid_at: date ? dhakaTimestamp(date, '12:00') : null,
    counterparty_phone: null,
    balance_paisa: m[3] ? tryParseBDT(m[3]) : null,
  };
}

export function parsePaymentSms(input: string): ParsedSms {
  try {
    const text = input.replace(/\s+/g, ' ').trim();
    if (!text) return EMPTY;
    const method = /nagad/i.test(text) ? 'nagad' : 'bkash';
    return bankDeposit(text) ?? wallet(text, method) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
