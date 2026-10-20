import { z } from 'zod';
import { phoneSchema } from './common';

export const memberUpdateSchema = z.object({
  photo_file_id: z.string().uuid().optional(),
  notify_prefs: z
    .object({
      push: z.boolean().optional(),
      sms: z.boolean().optional(),
      digits: z.enum(['bn', 'en']).optional(),
    })
    .optional(),
});

export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

export const memberContactUpdateSchema = z.object({
  phone: phoneSchema.optional(),
  full_name: z.string().trim().min(1).max(100).optional(),
});

export type MemberContactUpdate = z.infer<typeof memberContactUpdateSchema>;
