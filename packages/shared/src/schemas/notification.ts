import { z } from 'zod';
import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from '../enums';
import { paginationSchema } from './common';

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

export const deviceRegisterSchema = z.object({
  fcm_token: z.string().min(1).max(500).optional(),
  push_enabled: z.boolean().default(true),
});

export type DeviceRegister = z.infer<typeof deviceRegisterSchema>;

export const notificationsQuerySchema = z.object({
  status: notificationStatusSchema.optional(),
  channel: notificationChannelSchema.optional(),
  unread_only: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  ...paginationSchema.shape,
});

export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

export const nudgeSchema = z.object({
  member_id: z.string().uuid(),
  template: z.enum([
    'due_reminder',
    'fine_notice',
    'payment_submitted_ack',
    'payment_confirmed',
    'payment_rejected',
  ]),
});

export type NudgeInput = z.infer<typeof nudgeSchema>;

export const adminNotificationsQuerySchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid period format')
    .optional(),
  member_id: z.string().uuid().optional(),
  template: z.string().optional(),
  ...paginationSchema.shape,
});

export type AdminNotificationsQuery = z.infer<typeof adminNotificationsQuerySchema>;

export const appVersionSchema = z.object({
  min: z.string().regex(/^\d+\.\d+\.\d+$/),
  latest: z.string().regex(/^\d+\.\d+\.\d+$/),
  download_url: z.string().url(),
});

export type AppVersion = z.infer<typeof appVersionSchema>;
