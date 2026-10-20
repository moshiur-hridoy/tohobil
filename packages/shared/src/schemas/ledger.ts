import { z } from 'zod';
import { ACCOUNT_CODES } from '../enums';
import { dateSchema, paginationSchema, uuidSchema } from './common';

export const refTypeSchema = z.string().regex(/^[a-z_]{1,40}$/, 'Invalid reference type');

/** `GET /ledger`: newest first by default; `account` matches the debit or the credit side. */
export const ledgerQuerySchema = paginationSchema.extend({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  account: z.enum(ACCOUNT_CODES).optional(),
  member_id: uuidSchema.optional(),
  ref_type: refTypeSchema.optional(),
  ref_id: uuidSchema.optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

/** `GET /audit-log` (cashier, auditor). `from` and `to` are Asia/Dhaka dates, both inclusive. */
export const auditLogQuerySchema = paginationSchema.extend({
  actor_user_id: uuidSchema.optional(),
  action: z.string().min(1).max(100).optional(),
  entity_type: z.string().min(1).max(100).optional(),
  entity_id: z.string().min(1).max(100).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
