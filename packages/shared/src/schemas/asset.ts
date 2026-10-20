import { z } from 'zod';
import { ASSET_KINDS, ASSET_STATUSES, ASSET_UNITS, PAYMENT_METHODS } from '../enums';
import { dateSchema, paginationSchema, positivePaisaSchema, uuidSchema } from './common';

export const assetListQuerySchema = z.object({
  status: z.enum(ASSET_STATUSES).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  ...paginationSchema.shape,
});

export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export const assetCreateSchema = z.object({
  kind: z.enum(ASSET_KINDS),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  location: z.string().trim().max(500).optional(),
  acquired_on: dateSchema.optional(),
  cost_paisa: positivePaisaSchema,
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Quantity must be a decimal with up to 4 places').optional(),
  unit: z.enum(ASSET_UNITS).optional(),
  status: z.enum(ASSET_STATUSES).default('planned'),
  legal_owner_name: z.string().trim().max(200).optional(),
  ownership_split: z.record(z.any()).optional(),
  compliance: z.record(z.any()).optional(),
  feasibility_file_id: uuidSchema.optional(),
  proposal_id: uuidSchema.optional(),
  sold_on: dateSchema.optional(),
  sale_price_paisa: positivePaisaSchema.optional(),
});

export type AssetCreate = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = assetCreateSchema.partial();
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;

export const assetValuationCreateSchema = z.object({
  value_paisa: positivePaisaSchema,
  as_of: dateSchema,
  basis: z.string().trim().max(1000).optional(),
  proposal_id: uuidSchema.optional(),
});

export type AssetValuationCreate = z.infer<typeof assetValuationCreateSchema>;

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
