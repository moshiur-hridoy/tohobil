import { z } from 'zod';
import { DUE_STATUSES, FINE_STATUSES } from '../enums';
import { paginationSchema, periodSchema, uuidSchema } from './common';

/** `GET /dues?period&member_id&status&cursor&limit` */
export const duesQuerySchema = paginationSchema.extend({
  period: periodSchema.optional(),
  member_id: uuidSchema.optional(),
  status: z.enum(DUE_STATUSES).optional(),
});

export type DuesQuery = z.infer<typeof duesQuerySchema>;

/** `GET /fines?member_id&status&cursor&limit` */
export const finesQuerySchema = paginationSchema.extend({
  member_id: uuidSchema.optional(),
  status: z.enum(FINE_STATUSES).optional(),
});

export type FinesQuery = z.infer<typeof finesQuerySchema>;
