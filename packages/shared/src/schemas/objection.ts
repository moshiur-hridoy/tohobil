import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common';

/** `POST /objections`: any active member may object to any ledger row (5.12). */
export const objectionCreateSchema = z.object({
  ledger_seq: z.string().regex(/^[1-9]\d{0,17}$/, 'Invalid ledger sequence'),
  text: z.string().trim().min(3).max(1000),
});

export type ObjectionCreate = z.infer<typeof objectionCreateSchema>;

/** `PATCH /objections/:id`: the auditor resolves or dismisses with a note. */
export const objectionResolveSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  resolution: z.string().trim().min(3).max(1000),
});

export type ObjectionResolve = z.infer<typeof objectionResolveSchema>;

/** `GET /objections?status&ledger_seq&member_id` */
export const objectionsQuerySchema = paginationSchema.extend({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  ledger_seq: z.string().regex(/^[1-9]\d{0,17}$/).optional(),
  member_id: uuidSchema.optional(),
});

export type ObjectionsQuery = z.infer<typeof objectionsQuerySchema>;
