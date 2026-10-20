import { z } from 'zod';
import { PROPOSAL_STATUSES, PROPOSAL_TYPES, SETTLEMENT_KINDS, type ProposalType } from '../enums';
import {
  cashAccountSchema,
  dateSchema,
  paginationSchema,
  paisaStringSchema,
  phoneSchema,
  positivePaisaSchema,
  timestampSchema,
} from './common';

export const proposalCreateSchema = z.object({
  type: z.enum(PROPOSAL_TYPES),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(2000).optional(),
  subject_member_id: z.string().uuid().optional(),
  // Validated per type by validateProposalPayload (the registry below).
  payload: z.record(z.unknown()),
  clause_ref: z.string().max(50).optional(),
});

export type ProposalCreate = z.infer<typeof proposalCreateSchema>;

export const proposalsQuerySchema = paginationSchema.extend({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  type: z.enum(PROPOSAL_TYPES).optional(),
  subject_member_id: z.string().uuid().optional(),
});

export type ProposalsQuery = z.infer<typeof proposalsQuerySchema>;

export const proposalOpenSchema = z.object({
  closes_at: timestampSchema,
});

export type ProposalOpen = z.infer<typeof proposalOpenSchema>;

export const voteSchema = z.object({
  choice: z.enum(['yes', 'no', 'abstain']),
});

export type Vote = z.infer<typeof voteSchema>;

/**
 * Execute body. Approved proposals carry a *maximum*; the cashier supplies the actual figures:
 * the real cost of an expense/purchase, the sale price of an asset, the donation receipt.
 */
export const proposalExecuteSchema = z
  .object({
    actual_amount_paisa: positivePaisaSchema.optional(),
    account: cashAccountSchema.optional(),
    proof_file_id: z.string().uuid().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export type ProposalExecute = z.infer<typeof proposalExecuteSchema>;

// ---------------------------------------------------------------------------------------------
// Payload schemas per type. Money inside a payload is a digit string (it is stored as jsonb).
// ---------------------------------------------------------------------------------------------

export const fineWaiverPayloadSchema = z.object({
  fine_ids: z.array(z.string().uuid()).min(1),
  reason: z.string().min(3),
});

export const expensePayloadSchema = z.object({
  max_amount_paisa: paisaStringSchema,
  account: z.enum(['MAINTENANCE', 'OTHER_EXPENSE']),
  payee: z.string().min(1),
  purpose: z.string().min(3),
});

/** All of these must be true before an investment proposal can be opened (18.3). */
export const complianceChecklistSchema = z.object({
  interest_free_instrument: z.boolean(),
  not_conventional_fixed_deposit: z.boolean(),
  not_conventional_insurance: z.boolean(),
  not_speculative_trading: z.boolean(),
  permissible_business: z.boolean(),
  liquidatable_within_term: z.boolean(),
  no_fixed_profit_promised: z.boolean(),
});

export const investmentPurchasePayloadSchema = z.object({
  kind: z.enum(['gold', 'land', 'house', 'other']),
  name: z.string().min(1),
  max_amount_paisa: paisaStringSchema,
  quantity: z.number().positive().optional(),
  unit: z.enum(['vori', 'gram']).optional(),
  source_account: cashAccountSchema,
  notes: z.string().optional(),
  compliance: complianceChecklistSchema,
  feasibility_file_id: z.string().uuid().optional(),
});

export const assetSalePayloadSchema = z.object({
  asset_id: z.string().uuid(),
  min_price_paisa: paisaStringSchema,
});

export const valuationUpdatePayloadSchema = z.object({
  items: z
    .array(
      z.object({
        asset_id: z.string().uuid(),
        value_paisa: paisaStringSchema,
        basis: z.string().optional(),
        as_of: dateSchema,
      }),
    )
    .min(1),
});

export const newMemberPayloadSchema = z.object({
  name: z.string().min(1),
  phone: phoneSchema,
  shares: z.number().int().positive(),
  nominees: z.array(z.object({ name: z.string(), relation: z.string() })).optional(),
  note: z.string().optional(),
});

export const suspensionPayloadSchema = z.object({
  member_id: z.string().uuid(),
  reason: z.string().min(3),
  clause_ref: z.string().optional(),
});

export const reinstatementPayloadSchema = z.object({
  member_id: z.string().uuid(),
  terms: z.string().optional(),
});

export const settlementPayloadSchema = z.object({
  member_id: z.string().uuid(),
  kind: z.enum(SETTLEMENT_KINDS),
  payout_plan: z.array(z.object({ due_on: dateSchema, amount_paisa: paisaStringSchema })).min(1),
});

export const memberDeceasedPayloadSchema = z.object({
  member_id: z.string().uuid(),
  nominee_name: z.string().min(1),
  nominee_relation: z.string().optional(),
  document_file_id: z.string().uuid().optional(),
});

export const distributionPayloadSchema = z.object({
  total_paisa: paisaStringSchema,
  source_account: cashAccountSchema,
});

export const ruleChangePayloadSchema = z.object({
  key: z.string().min(1),
  value: z.unknown().refine((v) => v !== undefined, 'value is required'),
  valid_from: dateSchema,
  clause_ref: z.string().optional(),
});

export const constitutionAmendmentPayloadSchema = z.object({
  version: z.string().min(1),
  file_id: z.string().uuid(),
  effective_from: dateSchema,
  summary: z.string().min(3),
});

export const roleChangePayloadSchema = z.object({
  role: z.enum(['cashier', 'auditor']),
  member_id: z.string().uuid(),
});

/** The receipt is NOT part of the proposal: it exists only after the donation, so it is supplied at execute. */
export const charityDonationPayloadSchema = z.object({
  recipient: z.string().min(1),
  amount_paisa: paisaStringSchema,
  purpose: z.string().min(3),
});

export const contributionChangePayloadSchema = z.object({
  new_amount_paisa: paisaStringSchema,
  reason: z.string().min(3),
  effective_from: dateSchema,
});

export const assetCostLevyPayloadSchema = z.object({
  total_paisa: paisaStringSchema,
  asset_id: z.string().uuid().optional(),
  due_date: dateSchema,
  reason: z.string().min(3),
});

export const memberQardPayloadSchema = z.object({
  direction: z.enum(['receive', 'repay']),
  lender_member_id: z.string().uuid(),
  amount_paisa: paisaStringSchema,
  account: cashAccountSchema,
});

export const financingArrangementPayloadSchema = z.object({
  counterparty: z.string().min(1),
  description: z.string().min(3),
  total_paisa: paisaStringSchema,
  instalments: z.array(z.object({ due_on: dateSchema, amount_paisa: paisaStringSchema })).min(1),
});

export const generalPayloadSchema = z.object({
  text: z.string().min(3),
});

export const windUpPayloadSchema = z.object({
  asset_ids_to_sell: z.array(z.string().uuid()),
  distribution_plan: z.string().min(3),
});

/**
 * One payload schema per proposal type. `satisfies` makes adding a type to PROPOSAL_TYPES a
 * compile error until it has a schema.
 */
export const PROPOSAL_PAYLOAD_SCHEMAS = {
  fine_waiver: fineWaiverPayloadSchema,
  expense: expensePayloadSchema,
  investment_purchase: investmentPurchasePayloadSchema,
  asset_sale: assetSalePayloadSchema,
  valuation_update: valuationUpdatePayloadSchema,
  new_member: newMemberPayloadSchema,
  suspension: suspensionPayloadSchema,
  reinstatement: reinstatementPayloadSchema,
  settlement: settlementPayloadSchema,
  member_deceased: memberDeceasedPayloadSchema,
  distribution: distributionPayloadSchema,
  rule_change: ruleChangePayloadSchema,
  constitution_amendment: constitutionAmendmentPayloadSchema,
  role_change: roleChangePayloadSchema,
  general: generalPayloadSchema,
  charity_donation: charityDonationPayloadSchema,
  contribution_change: contributionChangePayloadSchema,
  asset_cost_levy: assetCostLevyPayloadSchema,
  member_qard: memberQardPayloadSchema,
  financing_arrangement: financingArrangementPayloadSchema,
  dissolution: generalPayloadSchema,
  wind_up: windUpPayloadSchema,
  land_selection: generalPayloadSchema,
  project_closure: generalPayloadSchema,
} as const satisfies Record<ProposalType, z.ZodTypeAny>;

/**
 * Validate a proposal payload against the schema for its type.
 */
export function validateProposalPayload<T extends ProposalType>(
  type: T,
  payload: unknown,
): z.SafeParseReturnType<unknown, z.output<(typeof PROPOSAL_PAYLOAD_SCHEMAS)[T]>> {
  return PROPOSAL_PAYLOAD_SCHEMAS[type].safeParse(payload) as z.SafeParseReturnType<
    unknown,
    z.output<(typeof PROPOSAL_PAYLOAD_SCHEMAS)[T]>
  >;
}
