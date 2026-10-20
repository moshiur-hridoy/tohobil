import { z } from 'zod';
import { PAYMENT_METHODS } from '../enums';
import { dateSchema, paisaSchema, uuidSchema } from './common';

export const charityQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type CharityQuery = z.infer<typeof charityQuerySchema>;

export const charityStatementQuerySchema = z.object({
  year: z.string().regex(/^\d{4}$/, 'Expected a four-digit year'),
});

export type CharityStatementQuery = z.infer<typeof charityStatementQuerySchema>;

export const charityDonationReceiptSchema = z.object({
  proposal_id: uuidSchema,
  actual_amount_paisa: paisaSchema,
  method: z.enum(PAYMENT_METHODS),
  note: z.string().max(500).optional(),
  proof_file_id: uuidSchema.optional(),
});

export type CharityDonationReceipt = z.infer<typeof charityDonationReceiptSchema>;
