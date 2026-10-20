/**
 * Shared enums and constants.
 */

export const MEMBER_STATUSES = [
  'prospective',
  'active',
  'warning',
  'suspended',
  'exited',
  'deceased',
  'inactive',
] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'confirmed', 'rejected', 'reversed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['bkash', 'nagad', 'bank', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_SOURCES = [
  'member_submitted',
  'cashier_entry',
  'sms_match',
  'import',
] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const PAYMENT_PURPOSES = ['dues', 'entry', 'settlement_shortfall', 'levy'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const DUE_KINDS = ['monthly', 'start_boost', 'entry', 'levy'] as const;
export type DueKind = (typeof DUE_KINDS)[number];

export const FINE_KINDS = ['late_payment', 'absence'] as const;
export type FineKind = (typeof FINE_KINDS)[number];

/** Derived from allocations and the due date (view `v_due_status`, spec 5.3). */
export const DUE_STATUSES = ['unpaid', 'partial', 'overdue', 'paid', 'paid_late'] as const;
export type DueStatus = (typeof DUE_STATUSES)[number];

/** Derived from allocations and the waiver (view `v_fine_status`, spec 5.5). */
export const FINE_STATUSES = ['unpaid', 'partial', 'paid', 'waived'] as const;
export type FineStatus = (typeof FINE_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  'draft',
  'open',
  'approved',
  'rejected',
  'executed',
  'lapsed',
  'cancelled',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_TYPES = [
  'fine_waiver',
  'expense',
  'investment_purchase',
  'asset_sale',
  'valuation_update',
  'new_member',
  'suspension',
  'reinstatement',
  'settlement',
  'member_deceased',
  'distribution',
  'rule_change',
  'constitution_amendment',
  'role_change',
  'general',
  'charity_donation',
  'contribution_change',
  'asset_cost_levy',
  'member_qard',
  'financing_arrangement',
  'dissolution',
  'wind_up',
  'land_selection',
  'project_closure',
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const VOTING_BASES = ['member', 'share'] as const;
export type VotingBasis = (typeof VOTING_BASES)[number];

export const THRESHOLD_KINDS = ['majority', 'unanimous'] as const;
export type ThresholdKind = (typeof THRESHOLD_KINDS)[number];

export const ASSET_KINDS = ['gold', 'land', 'house', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUSES = ['planned', 'acquiring', 'held', 'sold'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_UNITS = ['vori', 'gram'] as const;
export type AssetUnit = (typeof ASSET_UNITS)[number];

export const RENT_STATUSES = ['expected', 'received', 'overdue', 'skipped'] as const;
export type RentStatus = (typeof RENT_STATUSES)[number];

export const SETTLEMENT_KINDS = [
  'early_exit',
  'compassionate_exit',
  'inactive_return',
  'death_surrender',
  'wind_up',
] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

export const USER_ROLES = ['member', 'cashier', 'auditor'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['pending_activation', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const DEVICE_PLATFORMS = ['android', 'web', 'ios'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_EVENT_KINDS = ['registered', 'revoked', 'reset'] as const;
export type DeviceEventKind = (typeof DEVICE_EVENT_KINDS)[number];

/** Compliance checklist fields for investment proposals (spec 18.3). */
export const COMPLIANCE_CHECKLIST_FIELDS = [
  'interest_free_instrument',
  'not_conventional_fixed_deposit',
  'not_conventional_insurance',
  'not_speculative_trading',
  'permissible_business',
  'liquidatable_within_term',
  'no_fixed_profit_promised',
] as const;

export const NOTIFICATION_CHANNELS = ['push', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ACCOUNT_CODES = [
  'CASH',
  'BANK',
  'BKASH',
  'NAGAD',
  'INVESTMENTS_AT_COST',
  'MEMBER_CAPITAL',
  'OPENING_ADJUSTMENT',
  'SETTLEMENT_PAYABLE',
  'MEMBER_ESCROW',
  'CHARITY_PAYABLE',
  'LEVY_CLEARING',
  'INACTIVE_HELD',
  'MEMBER_QARD',
  'DEFERRED_PURCHASE_PAYABLE',
  'FINE_INCOME',
  'RENT_INCOME',
  'BANK_PROFIT',
  'ASSET_GAIN',
  'OTHER_INCOME',
  'EXIT_FEE_INCOME',
  'BANK_CHARGE',
  'SMS_CHARGE',
  'MAINTENANCE',
  'ASSET_LOSS',
  'OTHER_EXPENSE',
  'DISTRIBUTIONS',
] as const;
export type AccountCode = (typeof ACCOUNT_CODES)[number];

export const CASH_ACCOUNT_CODES = ['CASH', 'BANK', 'BKASH', 'NAGAD'] as const;
export type CashAccountCode = (typeof CASH_ACCOUNT_CODES)[number];

/**
 * Net asset value (spec 5.7 as amended by 18.4 and 19.2). `net_assets` is
 *   cash accounts + valuation of held assets (and cost paid so far for assets still being acquired)
 *   - the natural balance of every account in NAV_DEDUCTION_ACCOUNTS.
 * None of these deductions is fund money: they are owed to someone (a leaving member, charity, the
 * registrar, an inactive member, a member who lent to the fund, a seller). Charity money in
 * particular (fines, absence fines, bank interest, 18.2) never raises NAV or member profit.
 * Phase 4 builds `GET /nav` from these lists; they live here so the exclusions are written once.
 */
export const NAV_CASH_ACCOUNTS = CASH_ACCOUNT_CODES;
export const NAV_DEDUCTION_ACCOUNTS = [
  'SETTLEMENT_PAYABLE',
  'MEMBER_ESCROW',
  'CHARITY_PAYABLE',
  'LEVY_CLEARING',
  'INACTIVE_HELD',
  'MEMBER_QARD',
  'DEFERRED_PURCHASE_PAYABLE',
] as const satisfies readonly AccountCode[];
/** Asset account that is never counted directly: the asset's valuation replaces it. */
export const NAV_REPLACED_BY_VALUATION_ACCOUNT = 'INVESTMENTS_AT_COST' as const;

/**
 * The cash account a payment method posts to (spec 5.4): `other` posts to BANK.
 */
export function methodAccount(method: PaymentMethod): CashAccountCode {
  switch (method) {
    case 'bkash':
      return 'BKASH';
    case 'nagad':
      return 'NAGAD';
    case 'cash':
      return 'CASH';
    case 'bank':
    case 'other':
      return 'BANK';
  }
}

export const APPROVAL_KINDS = [
  'payment_reversal',
  'reconciliation',
  'period_lock',
  'annual_audit',
  'inactive_declaration',
  'death_surrender',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/**
 * Payment method display labels (Bengali).
 * Note: Nagad is labeled as "Nagad" not "নগদ" per spec 19.3.
 */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, { bn: string; en: string }> = {
  bkash: { bn: 'বিকাশ', en: 'bKash' },
  nagad: { bn: 'Nagad', en: 'Nagad' },
  bank: { bn: 'ব্যাংক', en: 'Bank' },
  cash: { bn: 'হাতে নগদ', en: 'Cash in hand' },
  other: { bn: 'অন্যান্য', en: 'Other' },
};
