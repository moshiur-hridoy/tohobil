/** Response shapes of the API as the screens use them. Money is always a decimal string of paisa. */

import type { ProposalStatus, ProposalType, ThresholdKind, VotingBasis } from '@barakah/shared';

export type DueStatus = 'paid' | 'paid_late' | 'partial' | 'unpaid' | 'overdue';
export type PaymentStatus = 'pending' | 'confirmed' | 'rejected' | 'reversed';

export interface MemberRow {
  id: string;
  code: string;
  full_name: string;
  status: string;
  phone: string | null;
  shares: number;
  capital_paisa: string;
  /** Every unpaid due, including ones generated ahead that are not due yet. */
  outstanding_principal_paisa: string;
  /** Unpaid dues past their due date: arrears (বকেয়া). */
  overdue_paisa: string;
  outstanding_fines_paisa: string;
  overdue_count: number;
  current_period: string;
  current_period_status: DueStatus | null;
  under_verification: boolean;
  joined_on: string | null;
}

export interface DueRow {
  id: string;
  member_id: string;
  period: string;
  kind: 'monthly' | 'start_boost' | 'entry' | 'levy';
  amount_paisa: string;
  allocated_paisa: string;
  outstanding_paisa: string;
  due_date: string;
  status: DueStatus;
  under_verification: boolean;
}

export interface FineRow {
  id: string;
  member_id: string;
  period: string | null;
  amount_paisa: string;
  outstanding_paisa: string;
  status: 'unpaid' | 'partial' | 'paid' | 'waived';
}

export interface PaymentRow {
  id: string;
  member_id: string;
  member_code: string;
  member_name: string;
  amount_paisa: string;
  method: 'bkash' | 'nagad' | 'bank' | 'cash' | 'other';
  purpose: string;
  trx_id: string | null;
  paid_at: string;
  status: PaymentStatus;
  source: 'member_submitted' | 'cashier_entry' | 'sms_match' | 'import';
  for_periods: string[] | null;
  proof_file_id: string | null;
  has_raw_sms: boolean;
  note: string | null;
  reject_reason: string | null;
  unallocated_paisa: string;
  submitted_at: string;
  confirmed_at: string | null;
}

export interface AllocationPreview {
  principal_paisa: string;
  fine_paisa: string;
  credit_paisa: string;
  lines: Array<{ due_id?: string; fine_id?: string; amount_paisa: string }>;
}

export interface PaymentDetail extends PaymentRow {
  allocations: Array<{ due_id: string | null; fine_id: string | null; period: string | null; due_kind: string | null; amount_paisa: string }>;
  raw_sms: string | null;
  preview: AllocationPreview | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface LedgerRow {
  seq: string;
  entry_date: string;
  debit_account: string;
  credit_account: string;
  amount_paisa: string;
  member_id: string | null;
  member_code: string | null;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  hash: string;
  reverses_seq: string | null;
  reversed_by_seq: string | null;
  posted_by_code: string | null;
  open_objections: number;
}

export interface AccountBalance {
  code: string;
  name: string;
  kind: string;
  is_cash: boolean;
  retired: boolean;
  balance_paisa: string;
  natural_balance_paisa: string;
}

export interface MatrixCell {
  status: DueStatus;
  due_paisa: string;
  paid_paisa: string;
  fine_paisa: string;
  fine_paid_paisa: string;
  pending: boolean;
  /** Asia/Dhaka date of the latest payment to this month's dues. */
  paid_on: string | null;
  /** Paid in full before the month began, without a fine. */
  advance: boolean;
}

export interface MatrixResponse {
  from: string;
  to: string;
  periods: string[];
  members: Array<{
    member_id: string;
    member_code: string;
    member_name: string;
    member_status: string;
    cells: Record<string, MatrixCell | null>;
    totals: { due_paisa: string; paid_paisa: string; outstanding_paisa: string; fine_paisa: string; fine_paid_paisa: string };
  }>;
  totals_by_period: Record<string, { due_paisa: string; paid_paisa: string; fine_paisa: string; fine_paid_paisa: string }>;
}

export interface ObjectionRow {
  id: string;
  ledger_seq: string;
  member_code: string;
  member_name: string;
  text: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  created_at: string;
  entry_amount_paisa: string;
  entry_debit: string;
  entry_credit: string;
  entry_date: string;
}

export interface ApprovalRow {
  id: string;
  kind: string;
  ref_id: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by_code: string | null;
  payment_member_code: string | null;
  payment_amount_paisa: string | null;
  payment_method: string | null;
  payment_trx_id: string | null;
  created_at: string;
}

export interface ParsedSms {
  parsed: boolean;
  method: PaymentRow['method'] | null;
  amount_paisa: string | null;
  trx_id: string | null;
  paid_at: string | null;
  counterparty_phone: string | null;
  balance_paisa: string | null;
  matches: Array<{
    payment_id: string;
    match_type: 'trx_id' | 'amount_phone';
    member_id: string;
    member_code: string;
    amount_paisa: string;
    exact: boolean;
  }>;
}

export interface PaymentInstructions {
  bkash: string;
  nagad: string;
  bank: string;
}

export interface AssetRow {
  id: string;
  kind: 'gold' | 'land' | 'house' | 'other';
  name: string;
  description: string | null;
  location: string | null;
  acquired_on: string | null;
  cost_paisa: string;
  quantity: string | null;
  unit: 'vori' | 'gram' | null;
  status: 'planned' | 'acquiring' | 'held' | 'sold';
  sold_on: string | null;
  sale_price_paisa: string | null;
  legal_owner_name: string | null;
  latest_value_paisa: string | null;
  latest_value_as_of: string | null;
  /** The shop this purchase belongs to, when it was bought through one. */
  partner_id?: string | null;
}

/** A shop the fund invests with, and what the contract says. */
export interface PartnerRow {
  id: string;
  kind: AssetRow['kind'];
  name: string;
  contract_date: string | null;
  rate_percent: number | null;
  period_months: number | null;
  sharing_policy: string | null;
  contract_note: string | null;
}

export interface HoldingEntry {
  seq: string;
  asset_id: string;
  entry_date: string;
  amount_paisa: string;
  account: string;
  memo: string | null;
  ref_type: string | null;
  reversed: boolean;
}

export interface HoldingDocument {
  id: string;
  entity_type: 'asset' | 'partner';
  entity_id: string;
  file_id: string;
  doc_type: string | null;
  title: string | null;
  mime: string;
}

export interface HoldingValuation {
  id: string;
  asset_id: string;
  value_paisa: string;
  as_of: string;
  basis: string | null;
}

export interface HoldingResponse {
  partner: PartnerRow;
  assets: AssetRow[];
  entries: HoldingEntry[];
  documents: HoldingDocument[];
  valuations: HoldingValuation[];
}

export interface NavResponse {
  net_assets_paisa: string;
  shares_outstanding: string;
  nav_per_share_paisa: string;
  cash: Array<{ account: string; balance_paisa: string }>;
  assets: Array<{
    id: string;
    name: string;
    status: string;
    valuation_paisa: string;
    value_as_of: string | null;
  }>;
  deductions: Array<{ account: string; balance_paisa: string }>;
  stale_valuations: Array<{ id: string; name: string; latest_as_of: string | null }>;
}

export interface NoticeRow {
  id: string;
  title: string;
  body: string | null;
  created_at: string;
  read: boolean;
}

export interface ProposalSummary {
  id: string;
  type: ProposalType;
  title: string;
  status: ProposalStatus;
  subject_member_id: string | null;
  basis: VotingBasis;
  threshold_kind: ThresholdKind;
  eligible_count: number;
  eligible_weight: string;
  threshold: number;
  threshold_weight: string;
  counts: {
    yes: number;
    no: number;
    abstain: number;
    yes_weight: string;
    no_weight: string;
    abstain_weight: string;
  };
  /** True while the vote is open: others' votes and the running tally are hidden. */
  ballots_hidden: boolean;
  /** How many have voted (never what); only sent to the cashier and the auditor. */
  voted_count?: number;
  /** Cashier and auditor only: the outcome is already certain, so an open vote may be closed early. */
  can_close_early?: boolean;
  opens_at: string | null;
  closes_at: string | null;
  finalized_at: string | null;
  executed_at: string | null;
  created_at: string;
  clause_ref: string | null;
  amount_paisa: string | null;
}

export interface ProposalVoter {
  member_id: string;
  full_name: string;
  code: string;
  weight: number;
}

export interface ProposalVote {
  member_id: string;
  choice: 'yes' | 'no' | 'abstain';
  cast_at: string;
}

export interface ProposalDetail extends ProposalSummary {
  description: string | null;
  subject: { full_name: string; code: string } | null;
  payload: Record<string, unknown>;
  voters: ProposalVoter[];
  votes: ProposalVote[];
}

export interface RuleRow {
  key: string;
  value: unknown;
  valid_from: string;
  clause_ref: string | null;
}

export interface RulesResponse {
  as_of: string | null;
  items: RuleRow[];
}

export interface MemberStatusEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  proposal_id: string | null;
  created_by: string;
  created_at: string;
}

export interface ContactLogItem {
  id: string;
  kind: string;
  outcome: string | null;
  note: string | null;
  at: string;
  by: string;
}

export interface MemberDetail {
  id: string;
  code: string;
  full_name: string;
  status: string;
  photo_file_id: string | null;
  phone: string | null;
  joined_on: string;
  suspended_on: string | null;
  exited_on: string | null;
  shares: number;
  capital_paisa: string;
  share_holdings: Array<Record<string, unknown>>;
  share_register: Array<Record<string, unknown>>;
  dues: DueRow[];
  fines: Array<Record<string, unknown>>;
  payments: Page<PaymentRow>;
  ledger: Page<LedgerRow>;
}

export interface CharityDonation {
  id: string;
  proposal_id: string;
  recipient: string;
  amount_paisa: string;
  donated_on: string;
  proof_file_id: string | null;
  ledger_seq: string | null;
}

export interface CharityEntry {
  seq: string;
  entry_date: string;
  direction: 'in' | 'out';
  kind: 'fine' | 'bank_profit' | 'donation' | 'reversal' | 'other';
  amount_paisa: string;
  member_code: string | null;
  member_name: string | null;
  recipient: string | null;
  memo: string | null;
}

export interface FundExpenseEntry {
  seq: string;
  entry_date: string;
  account: 'BANK_CHARGE' | 'SMS_CHARGE' | 'MAINTENANCE' | 'OTHER_EXPENSE';
  amount_paisa: string;
  memo: string | null;
}

export interface CharityStatement {
  year: string;
  opening_paisa: string;
  receipts_paisa: string;
  disbursements_paisa: string;
  closing_paisa: string;
  entries: CharityEntry[];
}

export interface FundExpenses {
  total_paisa: string;
  items: FundExpenseEntry[];
}

export interface ConstitutionVersionSummary {
  id: string;
  version: string;
  file_id: string | null;
  effective_from: string;
  summary: string | null;
  proposal_id: string | null;
  created_at: string;
}

export interface ConstitutionClause {
  id: string;
  clause_no: string;
  title: string | null;
  summary: string | null;
  body: string | null;
}

export interface ConstitutionVersion extends ConstitutionVersionSummary {
  clauses: ConstitutionClause[];
  acked_at?: string;
}

export interface OwnerConflict {
  id: string;
  title: string;
  description: string | null;
  status: 'open' | 'resolved';
  raised_at: string;
}

export interface SettlementView {
  id: string;
  member_id: string;
  member_code: string;
  member_name: string;
  kind: 'early_exit' | 'compassionate_exit' | 'inactive_return' | 'death_surrender' | 'wind_up';
  status: 'approved' | 'paying' | 'completed';
  gross_paisa: string;
  escrow_paisa: string;
  principal_paisa: string;
  fines_paisa: string;
  exit_fee_paisa: string;
  net_paisa: string;
  taken_on: string;
  payouts: Array<{ due_on: string; amount_paisa: string; paid_at: string | null }>;
}
