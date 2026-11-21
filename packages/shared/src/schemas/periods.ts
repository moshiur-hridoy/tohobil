import { z } from 'zod';
import { cashAccountSchema, paisaSchema, periodSchema } from './common';

export const yearSchema = z.string().regex(/^\d{4}$/, 'Invalid year (expected YYYY)');

/**
 * The cashier's month-end check (ASSUMPTIONS 132). `entries`: what each cash account really held. With
 * one cash pool (the default, ASSUMPTIONS 96) that is a single `BANK` row compared with cash, bank,
 * bKash and Nagad together; with `cash_tracking_by_method` on, one row for each of the four. `shops`:
 * for each shop that had money sent to it that month (or an approval in force), what its own statement
 * shows it received. The server decides which rows are needed; a difference needs a note.
 */
export const reconciliationSubmitSchema = z.object({
  period: periodSchema,
  entries: z
    .array(
      z.object({
        account: cashAccountSchema,
        actual_balance_paisa: paisaSchema,
        note: z.string().trim().max(500).optional(),
        proof_file_id: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(4)
    .refine((rows) => new Set(rows.map((r) => r.account)).size === rows.length, 'Each cash account at most once'),
  shops: z
    .array(
      z.object({
        partner_id: z.string().uuid(),
        statement_paisa: paisaSchema,
        note: z.string().trim().max(500).optional(),
        proof_file_id: z.string().uuid().optional(),
      }),
    )
    .max(50)
    .refine((rows) => new Set(rows.map((r) => r.partner_id)).size === rows.length, 'Each shop at most once')
    .default([]),
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
