import { z } from 'zod';
import { dateSchema, uuidSchema } from './common';

export const constitutionSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
});

export type ConstitutionSearchQuery = z.infer<typeof constitutionSearchQuerySchema>;

export const constitutionVersionCreateSchema = z.object({
  version: z.string().min(1).max(100),
  file_id: uuidSchema,
  effective_from: dateSchema,
  summary: z.string().min(3).max(1000),
  clauses: z
    .array(
      z.object({
        clause_no: z.string().min(1).max(50),
        title: z.string().max(200).optional(),
        summary: z.string().max(1000).optional(),
        body: z.string().max(20000).optional(),
      }),
    )
    .min(1),
});

export type ConstitutionVersionCreate = z.infer<typeof constitutionVersionCreateSchema>;
