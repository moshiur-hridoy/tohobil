import { z } from 'zod';
import { periodSchema } from './common';

/** `GET /matrix?from&to`: member x period grid. Defaults to the 12 periods ending this month. */
export const matrixQuerySchema = z.object({
  from: periodSchema.optional(),
  to: periodSchema.optional(),
});

export type MatrixQuery = z.infer<typeof matrixQuerySchema>;
