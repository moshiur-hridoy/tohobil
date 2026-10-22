import { z } from 'zod';
import { PAYMENT_METHODS } from '../enums';

export const versionStringSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** The methods a member can pick on the pay page when the cashier has not chosen any (docs/ASSUMPTIONS.md 97). */
export const DEFAULT_MEMBER_PAYMENT_METHODS = ['bkash', 'bank', 'cash'] as const;

/**
 * How to pay the fund. A number may be left empty when its method is switched off. `bank` is the
 * bank's name; the account number, account name and branch are separate so a member can copy each.
 */
export const paymentInstructionsValueSchema = z.object({
  bkash: z.string().trim().max(80),
  nagad: z.string().trim().max(80),
  bank: z.string().trim().max(250),
  bank_account: z.string().trim().max(40).optional(),
  bank_holder: z.string().trim().max(120).optional(),
  bank_branch: z.string().trim().max(120).optional(),
  methods: z.array(z.enum(PAYMENT_METHODS)).min(1).max(PAYMENT_METHODS.length).optional(),
});

export type PaymentInstructions = z.infer<typeof paymentInstructionsValueSchema>;

export const settingsUpdateSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('payment_instructions'), value: paymentInstructionsValueSchema }),
  z.object({ key: z.literal('fund_name'), value: z.string().trim().min(1).max(120) }),
  z.object({ key: z.literal('sms_enabled'), value: z.boolean() }),
  z.object({ key: z.literal('app_min_version'), value: versionStringSchema }),
  z.object({ key: z.literal('app_latest_version'), value: versionStringSchema }),
  z.object({ key: z.literal('apk_download_url'), value: z.string().url().max(500) }),
  z.object({ key: z.literal('zakat_notice_date'), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const settingReadWhitelist = ['payment_instructions', 'fund_name', 'zakat_notice_date'] as const;
