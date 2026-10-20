import { z } from 'zod';
import { ASSET_KINDS, ASSET_STATUSES, ASSET_UNITS, PAYMENT_METHODS } from '../enums';
import { cashAccountSchema, dateSchema, paginationSchema, positivePaisaSchema, uuidSchema } from './common';

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

/** Pay one instalment of a deferred purchase: DR DEFERRED_PURCHASE_PAYABLE, CR <account>. */
export const financingPaySchema = z.object({ account: cashAccountSchema });
export type FinancingPay = z.infer<typeof financingPaySchema>;
