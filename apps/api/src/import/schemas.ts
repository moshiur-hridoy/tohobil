import { z } from 'zod';
import {
  PAYMENT_METHODS,
  dateSchema,
  paisaSchema,
  periodSchema,
  timestampSchema,
} from '@barakah/shared';

/**
 * Normalized CSV schemas (Doc.md 13). One file per table; `FILES` fixes the column order that
 * `sheet-to-csv` writes and `load` reads. Paisa travels as a digit string and becomes a bigint here.
 */

const memberKey = z.string().regex(/^M\d{2}$/, 'member_key must look like M01');
const text = z.string().trim();
const optionalText = text.transform((v) => (v === '' ? null : v));
const optionalDate = text.transform((v) => (v === '' ? null : v)).pipe(dateSchema.nullable());
const signedPaisa = z.string().regex(/^-?\d{1,18}$/).transform((s) => BigInt(s));

export const memberRow = z.object({
  member_key: memberKey,
  full_name: text.min(1),
  phone: z.string().regex(/^\+8801[3-9]\d{8}$/, 'Invalid Bangladeshi phone number'),
  joined_on: dateSchema,
  status: z.enum(['prospective', 'active', 'warning', 'suspended', 'exited', 'deceased', 'inactive']),
});

export const shareHoldingRow = z.object({
  member_key: memberKey,
  shares: z.coerce.number().int().positive(),
  effective_from: dateSchema,
});

export const shareRegisterRow = z.object({
  share_no: z.coerce.number().int().positive(),
  member_key: memberKey,
  registered_name: text.min(1),
  nominee_name: optionalText,
  nominee_relation: optionalText,
});

export const dueRow = z.object({
  member_key: memberKey,
  period: periodSchema,
  kind: z.enum(['monthly', 'start_boost']),
  shares_snapshot: z.coerce.number().int().positive(),
  amount_paisa: paisaSchema,
  due_date: dateSchema,
});

export const fineRow = z.object({
  member_key: memberKey,
  period: periodSchema,
  amount_paisa: paisaSchema.refine((v) => v > 0n, 'A fine must be positive'),
  status: z.enum(['paid', 'unpaid', 'waived']),
});

export const paymentRow = z.object({
  payment_key: text.min(1),
  member_key: memberKey,
  amount_paisa: paisaSchema.refine((v) => v > 0n, 'A payment must be positive'),
  method: z.enum(PAYMENT_METHODS),
  trx_id: optionalText,
  paid_at: timestampSchema,
  note: optionalText,
  raw_sms: optionalText,
});

export const allocationRow = z.object({
  payment_key: text.min(1),
  member_key: memberKey,
  period: periodSchema,
  kind: z.enum(['principal', 'fine']),
  amount_paisa: paisaSchema.refine((v) => v > 0n, 'An allocation must be positive'),
});

export const assetRow = z.object({
  asset_key: text.min(1),
  kind: z.enum(['gold', 'land', 'house', 'other']),
  name: text.min(1),
  acquired_on: optionalDate,
  cost_paisa: paisaSchema,
  quantity: text.transform((v) => (v === '' ? null : v)).pipe(z.string().regex(/^\d+(\.\d{1,4})?$/).nullable()),
  unit: text.transform((v) => (v === '' ? null : v)).pipe(z.enum(['vori', 'gram']).nullable()),
  status: z.enum(['planned', 'acquiring', 'held', 'sold']),
  source_account: z.enum(['CASH', 'BANK', 'BKASH', 'NAGAD']),
});

/** What a shop reports a purchase is now worth (for example profit it kept in gold); not a cash entry. */
export const valuationRow = z.object({
  asset_key: z.string().trim().min(1),
  value_paisa: paisaSchema,
  as_of: dateSchema,
  basis: text.transform((v) => (v === '' ? null : v)),
});

export const miscLedgerRow = z.object({
  entry_date: dateSchema,
  debit_account: z.string().regex(/^[A-Z_]+$/),
  credit_account: z.string().regex(/^[A-Z_]+$/),
  amount_paisa: paisaSchema.refine((v) => v > 0n, 'An entry must be positive'),
  memo: text,
  member_key: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(memberKey.nullable()),
});

export const openingBalanceRow = z.object({
  account: z.enum(['CASH', 'BANK', 'BKASH', 'NAGAD']),
  actual_balance_paisa: signedPaisa,
  as_of: dateSchema,
});

export const expectedTotalsRow = z.object({
  member_key: memberKey,
  principal_paid_paisa: paisaSchema,
  fines_paid_paisa: paisaSchema,
  principal_outstanding_paisa: paisaSchema,
  fines_outstanding_paisa: paisaSchema,
});

export const FILES = {
  members: { file: 'members.csv', schema: memberRow, columns: ['member_key', 'full_name', 'phone', 'joined_on', 'status'] },
  share_holdings: { file: 'share_holdings.csv', schema: shareHoldingRow, columns: ['member_key', 'shares', 'effective_from'] },
  share_register: { file: 'share_register.csv', schema: shareRegisterRow, columns: ['share_no', 'member_key', 'registered_name', 'nominee_name', 'nominee_relation'] },
  dues: { file: 'dues.csv', schema: dueRow, columns: ['member_key', 'period', 'kind', 'shares_snapshot', 'amount_paisa', 'due_date'] },
  fines: { file: 'fines.csv', schema: fineRow, columns: ['member_key', 'period', 'amount_paisa', 'status'] },
  payments: { file: 'payments.csv', schema: paymentRow, columns: ['payment_key', 'member_key', 'amount_paisa', 'method', 'trx_id', 'paid_at', 'note', 'raw_sms'] },
  allocations: { file: 'allocations.csv', schema: allocationRow, columns: ['payment_key', 'member_key', 'period', 'kind', 'amount_paisa'] },
  assets: { file: 'assets.csv', schema: assetRow, columns: ['asset_key', 'kind', 'name', 'acquired_on', 'cost_paisa', 'quantity', 'unit', 'status', 'source_account'] },
  valuations: { file: 'valuations.csv', schema: valuationRow, columns: ['asset_key', 'value_paisa', 'as_of', 'basis'] },
  misc_ledger: { file: 'misc_ledger.csv', schema: miscLedgerRow, columns: ['entry_date', 'debit_account', 'credit_account', 'amount_paisa', 'memo', 'member_key'] },
  opening_balances: { file: 'opening_balances.csv', schema: openingBalanceRow, columns: ['account', 'actual_balance_paisa', 'as_of'] },
  expected_totals: { file: 'expected_totals.csv', schema: expectedTotalsRow, columns: ['member_key', 'principal_paid_paisa', 'fines_paid_paisa', 'principal_outstanding_paisa', 'fines_outstanding_paisa'] },
} as const;

export type NormalizedName = keyof typeof FILES;

export type Dataset = {
  members: z.infer<typeof memberRow>[];
  share_holdings: z.infer<typeof shareHoldingRow>[];
  share_register: z.infer<typeof shareRegisterRow>[];
  dues: z.infer<typeof dueRow>[];
  fines: z.infer<typeof fineRow>[];
  payments: z.infer<typeof paymentRow>[];
  allocations: z.infer<typeof allocationRow>[];
  assets: z.infer<typeof assetRow>[];
  valuations: z.infer<typeof valuationRow>[];
  misc_ledger: z.infer<typeof miscLedgerRow>[];
  opening_balances: z.infer<typeof openingBalanceRow>[];
  expected_totals: z.infer<typeof expectedTotalsRow>[];
};
