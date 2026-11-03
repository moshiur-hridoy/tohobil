import { z } from 'zod';
import { ASSET_KINDS, ASSET_STATUSES, ASSET_UNITS, LEVY_EXPENSE_CATEGORIES, PAYMENT_METHODS } from '../enums';
import { cashAccountSchema, dateSchema, paginationSchema, paisaSchema, positivePaisaSchema, uuidSchema } from './common';

export const assetListQuerySchema = z.object({
  status: z.enum(ASSET_STATUSES).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  ...paginationSchema.shape,
});

export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

/** Who owns how many shares of a land or house; must add up to every share in the fund before it is held. */
export const ownershipSplitSchema = z
  .array(z.object({ member_id: uuidSchema, shares: z.number().int().positive() }))
  .min(1);

/**
 * A cashier may note down an asset the fund is only thinking about (status `planned`, no money).
 * Money moves and status changes only through proposals (purchase, valuation, sale), the staged
 * payments route and the completion route, so NAV can never move without a ledger entry and a vote.
 */
export const assetCreateSchema = z
  .object({
  kind: z.enum(ASSET_KINDS),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  location: z.string().trim().max(500).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Quantity must be a decimal with up to 4 places').optional(),
  unit: z.enum(ASSET_UNITS).optional(),
  legal_owner_name: z.string().trim().max(200).optional(),
  ownership_split: ownershipSplitSchema.optional(),
  feasibility_file_id: uuidSchema.optional(),
  })
  .strict();

export type AssetCreate = z.infer<typeof assetCreateSchema>;

/** Descriptive fields only; cost, status, sale and valuation are never edited directly. */
export const assetUpdateSchema = z
  .object({
    ...assetCreateSchema.omit({ kind: true }).shape,
    acquired_on: dateSchema,
    compliance: z.record(z.any()),
  })
  .partial()
  .strict();
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

/** A further payment on an asset still being acquired (land or house bought in stages). */
export const assetPaymentSchema = z.object({
  amount_paisa: positivePaisaSchema,
  account: cashAccountSchema,
  note: z.string().trim().min(3).max(500),
});
export type AssetPayment = z.infer<typeof assetPaymentSchema>;

/** The cashier marks an acquisition complete: needs a note and a document on the asset. */
export const assetCompleteSchema = z.object({ note: z.string().trim().min(3).max(500) });
export type AssetComplete = z.infer<typeof assetCompleteSchema>;

export const documentAttachSchema = z.object({
  file_id: uuidSchema,
  doc_type: z.string().trim().max(50).optional(),
  title: z.string().trim().max(200).optional(),
});

export type DocumentAttach = z.infer<typeof documentAttachSchema>;

export const rentStreamCreateSchema = z.object({
  asset_id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(200),
  tenant_name: z.string().trim().max(200).optional(),
  monthly_amount_paisa: positivePaisaSchema,
  due_day: z.coerce.number().int().min(1).max(28),
  active_from: dateSchema,
  active_to: dateSchema.optional(),
});

export type RentStreamCreate = z.infer<typeof rentStreamCreateSchema>;

export const rentStreamUpdateSchema = rentStreamCreateSchema.partial().omit({ active_from: true });
export type RentStreamUpdate = z.infer<typeof rentStreamUpdateSchema>;

export const rentReceiptSchema = z.object({
  amount_paisa: positivePaisaSchema,
  method: z.enum(PAYMENT_METHODS),
  paid_at: dateSchema,
  note: z.string().trim().max(500).optional(),
});

export type RentReceipt = z.infer<typeof rentReceiptSchema>;

export const rentExpectedQuerySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  stream_id: uuidSchema.optional(),
  status: z.enum(['expected', 'received', 'overdue', 'skipped']).optional(),
  ...paginationSchema.shape,
});

export type RentExpectedQuery = z.infer<typeof rentExpectedQuerySchema>;

/** The cashier hands collected levy money to the registrar (spec 18.7): DR LEVY_CLEARING, CR <account>. */
export const levyRemitSchema = z.object({
  amount_paisa: positivePaisaSchema,
  account: cashAccountSchema,
  payee: z.string().trim().min(1).max(200),
  note: z.string().trim().min(3).max(500),
});
export type LevyRemit = z.infer<typeof levyRemitSchema>;

/**
 * A running cost paid from the levy fund: `DR LEVY_CLEARING, CR <account>`. Up to the rule
 * `levy_expense_max_without_vote_paisa` the cashier records it directly; above it needs a vote.
 */
export const levyExpenseSchema = z.object({
  category: z.enum(LEVY_EXPENSE_CATEGORIES),
  amount_paisa: positivePaisaSchema,
  account: cashAccountSchema,
  payee: z.string().trim().min(1).max(200),
  note: z.string().trim().min(3).max(500),
  receipt_file_id: uuidSchema.optional(),
});
export type LevyExpense = z.infer<typeof levyExpenseSchema>;

/** Pay one instalment of a deferred purchase: DR DEFERRED_PURCHASE_PAYABLE, CR <account>. */
export const financingPaySchema = z.object({ account: cashAccountSchema });
export type FinancingPay = z.infer<typeof financingPaySchema>;

/** A shop the fund invests with (for example a jeweller) and what the contract with it says. */
const partnerFields = {
  kind: z.enum(ASSET_KINDS),
  name: z.string().trim().min(1).max(200),
  contract_date: dateSchema.nullable().optional(),
  rate_percent: z.number().min(0).max(1000).nullable().optional(),
  period_months: z.number().int().min(1).max(120).nullable().optional(),
  sharing_policy: z.string().trim().max(4000).nullable().optional(),
  contract_note: z.string().trim().max(4000).nullable().optional(),
};
export const partnerCreateSchema = z.object(partnerFields).strict();
export type PartnerCreate = z.infer<typeof partnerCreateSchema>;
export const partnerUpdateSchema = z
  .object({
    ...partnerFields,
    /** The member who looks after the investment and sends its value updates; `null` clears it. */
    custodian_member_id: uuidSchema.nullable().optional(),
  })
  .omit({ kind: true })
  .partial()
  .strict();
export type PartnerUpdate = z.infer<typeof partnerUpdateSchema>;

/**
 * `POST /partners/:id/valuation-requests`: the responsible member (or the cashier) sends the shop's
 * new total value with its statement. A rise goes to the auditor, a fall or a large rise to a vote.
 */
export const valuationRequestSchema = z
  .object({
    new_value_paisa: paisaSchema,
    as_of: dateSchema,
    note: z.string().trim().max(500).optional(),
    proof_file_id: uuidSchema,
  })
  .strict();
export type ValuationRequestInput = z.infer<typeof valuationRequestSchema>;

/** A rise of more than this share of the current value goes to a vote instead of the auditor. */
export const VALUATION_AUDITOR_MAX_RISE_PERCENT = 10n;

/** Why an update goes to the members' vote rather than the auditor, or null when the auditor decides it. */
export type ValuationVoteReason = 'fall' | 'big_rise' | 'auditor' | 'no_auditor';

/**
 * Which way a value update goes (owner decision, ASSUMPTIONS 115): a rise of at most 10% is for the
 * auditor; a fall, a larger rise, an update that concerns the auditor, or a fund with no auditor goes
 * to the members' vote. The server decides; the app shows the same answer before sending.
 */
export function valuationVoteReason(input: { base: bigint; next: bigint; concernsAuditor: boolean; hasAuditor: boolean }): ValuationVoteReason | null {
  const rise = input.next - input.base;
  if (rise < 0n) return 'fall';
  if (!input.hasAuditor) return 'no_auditor';
  if (input.concernsAuditor) return 'auditor';
  const bigRise = input.base === 0n ? rise > 0n : rise * 100n > input.base * VALUATION_AUDITOR_MAX_RISE_PERCENT;
  return bigRise ? 'big_rise' : null;
}

/**
 * Spreads one total value over the purchases in proportion to what each cost, so the sum is exact:
 * the last purchase takes the rounding remainder. Purchases that cost nothing get no valuation.
 */
export function splitByCost(total: bigint, assets: ReadonlyArray<{ id: string; cost_paisa: string | bigint }>): Array<{ asset_id: string; value_paisa: bigint }> {
  const priced = assets.filter((a) => BigInt(a.cost_paisa) > 0n);
  const weight = priced.reduce((a, x) => a + BigInt(x.cost_paisa), 0n);
  if (weight === 0n) return [];
  let given = 0n;
  return priced.map((a, i) => {
    const value = i === priced.length - 1 ? total - given : (total * BigInt(a.cost_paisa)) / weight;
    given += value;
    return { asset_id: a.id, value_paisa: value };
  });
}
