import { z } from 'zod';
import { boolQuerySchema, dateSchema } from './common';

/**
 * `GET /rules`: the rule values in force on `as_of` (default today), one row per key. `history=true`
 * lists every version instead (rule rows are append-only, spec 5.2).
 */
export const rulesQuerySchema = z.object({
  key: z.string().min(1).max(100).optional(),
  as_of: dateSchema.optional(),
  history: boolQuerySchema.optional(),
});

export type RulesQuery = z.infer<typeof rulesQuerySchema>;
