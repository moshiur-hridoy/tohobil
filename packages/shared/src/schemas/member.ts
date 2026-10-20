import { z } from 'zod';
import { MEMBER_STATUSES } from '../enums';
import { boolQuerySchema, dateSchema, phoneSchema, uuidSchema } from './common';

export const memberListQuerySchema = z.object({
  status: z.enum(MEMBER_STATUSES).optional(),
});

export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

/** `PATCH /members/me`: a member edits their own photo and notification preferences. */
export const memberUpdateSchema = z.object({
  /** `null` removes the photo. */
  photo_file_id: z.string().uuid().nullable().optional(),
  notify_prefs: z
    .object({
      push: z.boolean().optional(),
      sms: z.boolean().optional(),
      digits: z.enum(['bn', 'en']).optional(),
    })
    .optional(),
});

export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

/** `PATCH /members/:id/contact`: the cashier corrects a name or phone number. */
export const memberContactUpdateSchema = z.object({
  phone: phoneSchema.optional(),
  full_name: z.string().trim().min(1).max(100).optional(),
});

export type MemberContactUpdate = z.infer<typeof memberContactUpdateSchema>;

/** `GET /share-holdings`: holdings in force on `as_of` (default today), or the full history. */
export const shareHoldingsQuerySchema = z.object({
  member_id: uuidSchema.optional(),
  as_of: dateSchema.optional(),
  history: boolQuerySchema.optional(),
});

export type ShareHoldingsQuery = z.infer<typeof shareHoldingsQuerySchema>;
