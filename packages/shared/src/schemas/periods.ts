import { z } from 'zod';
import { cashAccountSchema, paisaSchema, periodSchema } from './common';

export const yearSchema = z.string().regex(/^\d{4}$/, 'Invalid year (expected YYYY)');

/**
 * The cashier's count at the end of a month: one actual balance for each of the four cash accounts.
 * A difference from the books needs a note, and the auditor is told about it.
 */
export const reconciliationSubmitSchema = z.object({
  period: periodSchema,
  entries: z
    .array(
      z.object({
        account: cashAccountSchema,
        actual_balance_paisa: paisaSchema,
        note: z.string().trim().max(500).optional(),
      }),
    )
    .length(4)
    .refine((rows) => new Set(rows.map((r) => r.account)).size === 4, 'Each of the four cash accounts exactly once'),
});
export type ReconciliationSubmit = z.infer<typeof reconciliationSubmitSchema>;

export const reportStatementQuerySchema = z.object({
  member_id: z.string().uuid().optional(),
  /** `YYYY-MM` for a month or `YYYY` for a whole year. */
  period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
});

export const reportZakatQuerySchema = z.object({
  member_id: z.string().uuid().optional(),
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const EXPORT_ENTITIES = ['ledger', 'payments', 'dues', 'votes'] as const;
export const reportExportQuerySchema = z.object({
  entity: z.enum(EXPORT_ENTITIES),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
