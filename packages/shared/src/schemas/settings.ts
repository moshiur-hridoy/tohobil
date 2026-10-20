import { z } from 'zod';

export const versionStringSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const paymentInstructionsValueSchema = z.object({
  bkash: z.string().trim().min(1).max(80),
  nagad: z.string().trim().min(1).max(80),
  bank: z.string().trim().min(1).max(250),
});

export type PaymentInstructions = z.infer<typeof paymentInstructionsValueSchema>;

export const settingsUpdateSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('payment_instructions'), value: paymentInstructionsValueSchema }),
  z.object({ key: z.literal('fund_name'), value: z.string().trim().min(1).max(120) }),
  z.object({ key: z.literal('sms_enabled'), value: z.boolean() }),
  z.object({ key: z.literal('app_min_version'), value: versionStringSchema }),
  z.object({ key: z.literal('app_latest_version'), value: versionStringSchema }),
  z.object({ key: z.literal('apk_download_url'), value: z.string().url().max(500) }),
]);

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const settingReadWhitelist = ['payment_instructions', 'fund_name'] as const;
