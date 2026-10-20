import { methodAccount, type CashAccountCode, type PaymentMethod } from '@barakah/shared';
import { badRequest } from '../lib/errors';
import { LEDGER_REF, type PostingInput } from './service';

/**
 * Pure builders for the standard postings of spec 5.6 as amended by 18.2. They return
 * `PostingInput[]` for `postEntries`; they touch no database, so the routing rules are easy to test.
 */

export interface PaymentPostingInput {
  entryDate: string;
  method: PaymentMethod;
  memberId: string;
  paymentId: string;
  /** Allocated to dues (monthly, start boost, entry): becomes member capital. */
  principalPaisa: bigint;
  /** Where principal is credited: member capital, or `LEVY_CLEARING` for a levy (never capital, never NAV). */
  principalAccount?: 'MEMBER_CAPITAL' | 'LEVY_CLEARING';
  /** Unallocated remainder: still the member's capital (5.4). */
  creditPaisa: bigint;
  /** Allocated to fines (late or absence): charity money, never fund income (18.2). */
  finePaisa: bigint;
}

/**
 * The ledger entries of a confirmed payment (5.4), one per non-zero component, all with
 * `ref_type='payment'` and the member set:
 *
 *   principal -> DR <method account>, CR MEMBER_CAPITAL   (a levy credits LEVY_CLEARING instead, 18.7)
 *   credit    -> DR <method account>, CR MEMBER_CAPITAL
 *   fine      -> DR <method account>, CR CHARITY_PAYABLE      (18.2; FINE_INCOME is retired)
 *
 * `other` posts to BANK. The three components together always equal the payment amount.
 */
export function paymentPostings(i: PaymentPostingInput): PostingInput[] {
  const parts = [
    { name: 'principal', amount: i.principalPaisa, credit: i.principalAccount ?? 'MEMBER_CAPITAL' },
    { name: 'credit', amount: i.creditPaisa, credit: 'MEMBER_CAPITAL' },
    { name: 'fine', amount: i.finePaisa, credit: 'CHARITY_PAYABLE' },
  ] as const;
  if (parts.some((p) => p.amount < 0n)) {
    throw badRequest('ledger.invalid_amount', 'Payment components cannot be negative');
  }
  const cash = methodAccount(i.method);
  const entries = parts
    .filter((p) => p.amount > 0n)
    .map((p): PostingInput => ({
      entry_date: i.entryDate,
      debit: cash,
      credit: p.credit,
      amount_paisa: p.amount,
      member_id: i.memberId,
      ref_type: LEDGER_REF.payment,
      ref_id: i.paymentId,
      memo: p.name,
    }));
  if (entries.length === 0) {
    throw badRequest('ledger.invalid_amount', 'A payment must have a positive amount');
  }
  return entries;
}

export interface BankCreditInput {
  entryDate: string;
  /** Interest or any bank credit the cashier could not classify. */
  amountPaisa: bigint;
  refId?: string | null;
  memo?: string | null;
}

/**
 * Interest that arrives in the bank (18.2): charity money, not income and not member profit.
 *   DR BANK, CR CHARITY_PAYABLE, ref_type 'riba_received'.
 * Treating a credit as permitted profit (`BANK_PROFIT`) needs the cashier's tag and the auditor's
 * approval; that path is not built yet, so every untagged bank credit defaults to charity.
 */
export function ribaReceivedPosting(i: BankCreditInput): PostingInput {
  return {
    entry_date: i.entryDate,
    debit: 'BANK',
    credit: 'CHARITY_PAYABLE',
    amount_paisa: i.amountPaisa,
    member_id: null,
    ref_type: LEDGER_REF.ribaReceived,
    ref_id: i.refId ?? null,
    memo: i.memo ?? 'Bank interest received (charity)',
  };
}

export interface AutoChargeInput {
  entryDate: string;
  charge: 'BANK_CHARGE' | 'SMS_CHARGE';
  /** The account the charge was taken from. */
  paidFrom: CashAccountCode;
  amountPaisa: bigint;
  memo?: string | null;
}

/**
 * A bank or SMS charge the provider took on its own: the only ledger posting allowed without a
 * proposal (5.6). It carries `ref_type='auto_charge'` so the auditor's monthly review can list it.
 */
export function autoChargePosting(i: AutoChargeInput): PostingInput {
  return {
    entry_date: i.entryDate,
    debit: i.charge,
    credit: i.paidFrom,
    amount_paisa: i.amountPaisa,
    member_id: null,
    ref_type: LEDGER_REF.autoCharge,
    ref_id: null,
    memo: i.memo ?? (i.charge === 'BANK_CHARGE' ? 'Bank charge' : 'SMS charge'),
  };
}
