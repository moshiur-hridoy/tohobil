import { z } from 'zod';
import { PAYMENT_METHODS, PAYMENT_PURPOSES } from '../enums';
import { paisaOutSchema, periodSchema, positivePaisaSchema, timestampSchema } from './common';

/** Methods that settle through a counterparty that issues a transaction id (5.4). */
const METHODS_REQUIRING_TRX = ['bkash', 'nagad', 'bank'] as const;

/**
 * Member submission (`POST /payments`). The payer is always the authenticated member: there is
 * deliberately no `member_id` field, so a member cannot submit on someone else's behalf.
 */
export const paymentSubmitSchema = z
  .object({
    amount_paisa: positivePaisaSchema,
    method: z.enum(PAYMENT_METHODS),
    purpose: z.enum(PAYMENT_PURPOSES).default('dues'),
    trx_id: z.string().trim().min(1).max(100).optional(),
    paid_at: timestampSchema.optional(),
    for_periods: z.array(periodSchema).max(24).optional(),
    proof_file_id: z.string().uuid().optional(),
    note: z.string().max(500).optional(),
  })
  .refine(
    (data) => !(METHODS_REQUIRING_TRX as readonly string[]).includes(data.method) || !!data.trx_id,
    {
      path: ['trx_id'],
      message: 'TrxID is required for bKash, Nagad, and Bank payments',
    },
  );

export type PaymentSubmit = z.infer<typeof paymentSubmitSchema>;

/** A manual allocation line: exactly one of due_id / fine_id. */
export const allocationItemSchema = z
  .object({
    due_id: z.string().uuid().optional(),
    fine_id: z.string().uuid().optional(),
    amount_paisa: positivePaisaSchema,
  })
  .refine((item) => (item.due_id === undefined) !== (item.fine_id === undefined), {
    message: 'Provide exactly one of due_id or fine_id',
  });

export type AllocationItem = z.infer<typeof allocationItemSchema>;

/** Manual allocation list: may not allocate more than the payment amount (5.4). */
function allocationsWithinAmount(data: {
  amount_paisa: bigint;
  allocations?: AllocationItem[] | undefined;
}): boolean {
  if (!data.allocations) return true;
  const total = data.allocations.reduce((sum, a) => sum + a.amount_paisa, 0n);
  return total <= data.amount_paisa;
}

export const cashierEntrySchema = z
  .object({
    member_id: z.string().uuid(),
    amount_paisa: positivePaisaSchema,
    method: z.enum(PAYMENT_METHODS),
    purpose: z.enum(PAYMENT_PURPOSES).default('dues'),
    trx_id: z.string().trim().min(1).max(100).optional(),
    paid_at: timestampSchema,
    for_periods: z.array(periodSchema).max(24).optional(),
    note: z.string().max(500).optional(),
    raw_sms: z.string().max(2000).optional(),
    allocations: z.array(allocationItemSchema).max(100).optional(),
  })
  .refine(allocationsWithinAmount, {
    path: ['allocations'],
    message: 'Allocations exceed the payment amount',
  });

export type CashierEntry = z.infer<typeof cashierEntrySchema>;

/** Confirm body: optional manual allocation, validated against the payment amount by the service. */
export const paymentConfirmSchema = z.object({
  allocations: z.array(allocationItemSchema).max(100).optional(),
});

export type PaymentConfirm = z.infer<typeof paymentConfirmSchema>;

export const paymentRejectSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type PaymentReject = z.infer<typeof paymentRejectSchema>;

export const reverseRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type ReverseRequest = z.infer<typeof reverseRequestSchema>;

export const parseSmsSchema = z.object({
  text: z.string().min(1).max(5000),
});

export type ParseSms = z.infer<typeof parseSmsSchema>;

/** Parser output (response side: amounts serialise to digit strings). Parsing only suggests. */
export const parseSmsResultSchema = z.object({
  parsed: z.boolean(),
  method: z.enum(PAYMENT_METHODS).nullable(),
  amount_paisa: paisaOutSchema.nullable(),
  trx_id: z.string().nullable(),
  paid_at: z.string().nullable(),
  counterparty_phone: z.string().nullable(),
  balance_paisa: paisaOutSchema.nullable(),
  matches: z.array(
    z.object({
      payment_id: z.string().uuid(),
      match_type: z.enum(['trx_id', 'amount_phone']),
    }),
  ),
});

export type ParseSmsResult = z.input<typeof parseSmsResultSchema>;
