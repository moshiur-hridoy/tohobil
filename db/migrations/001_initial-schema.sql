-- Up Migration
-- 001: Initial schema for Barakah Fund System
-- This migration creates all base tables, triggers, and functions.
--
-- Conventions
--   * Money is bigint paisa. Business dates are `date` in Asia/Dhaka; timestamps are timestamptz (UTC).
--   * Append-only tables are protected by row triggers (UPDATE/DELETE) AND statement triggers (TRUNCATE),
--     and the application role is additionally denied those privileges (see GRANTS at the end).
--   * Ledger postings must run in READ COMMITTED (the default); the hash-chain trigger enforces this.
--   * Spec 18.8 says to fold schema changes into this file before first release; do not add ALTER
--     migrations for tables that have not shipped.

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- MEMBERS AND USERS
-- ============================================================

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^M[0-9]{2}$'),  -- M01, M02, etc. Login reference (19.1)
  full_name text NOT NULL,
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),  -- +8801XXXXXXXXX
  photo_file_id uuid,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('prospective','active','warning','suspended','exited','deceased','inactive')),
  joined_on date NOT NULL,
  suspended_on date,
  exited_on date,
  notify_prefs jsonb NOT NULL DEFAULT '{"push":true,"sms":false,"digits":"bn"}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL UNIQUE REFERENCES members,
  roles text[] NOT NULL DEFAULT '{member}'
    CHECK (roles <@ ARRAY['member','cashier','auditor']),
  status text NOT NULL DEFAULT 'pending_activation'
    CHECK (status IN ('pending_activation','active','disabled')),
  pin_hash text,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  disabled_at timestamptz,
  last_login_at timestamptz
);

-- Exactly one active cashier and one active auditor, never the same person (5.1, assumption 22).
-- 'disabled' users do not count. Role swaps must remove the old holder's role first (same transaction).
CREATE UNIQUE INDEX users_one_active_cashier ON users ((true))
  WHERE 'cashier' = ANY (roles) AND status <> 'disabled';
CREATE UNIQUE INDEX users_one_active_auditor ON users ((true))
  WHERE 'auditor' = ANY (roles) AND status <> 'disabled';
ALTER TABLE users ADD CONSTRAINT users_cashier_not_auditor
  CHECK (NOT ('cashier' = ANY (roles) AND 'auditor' = ANY (roles)));

CREATE TABLE activation_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  -- 'replace' revokes every old device on use (lost phone, new PIN); 'add' keeps them and is
  -- limited by max_devices_per_member / max_devices_privileged (cashier and auditor: phone + desktop).
  mode text NOT NULL DEFAULT 'replace' CHECK (mode IN ('replace','add')),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  label text,
  platform text NOT NULL CHECK (platform IN ('android','web','ios')),
  install_id text NOT NULL,
  fcm_token text,
  push_enabled boolean NOT NULL DEFAULT true,
  refresh_token_hash text,
  refresh_expires_at timestamptz,
  -- Last successful TOTP check on this device; step-up actions need it within 12 h (spec 7).
  step_up_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL CHECK (kind IN ('registered','revoked','reset')),
  at timestamptz NOT NULL DEFAULT now(),
  by uuid REFERENCES users
);

-- ============================================================
-- SHARES
-- ============================================================

CREATE TABLE share_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  shares int NOT NULL CHECK (shares > 0),
  effective_from date NOT NULL,
  effective_to date,
  source text NOT NULL CHECK (source IN ('initial','entry','transfer_in','import')),
  proposal_id uuid
);

CREATE TABLE share_register (
  share_no int PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES members,
  registered_name text NOT NULL,
  nominee_name text,
  nominee_relation text
);

-- ============================================================
-- RULES AND SETTINGS
-- ============================================================

CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  value jsonb NOT NULL,
  valid_from date NOT NULL,
  clause_ref text,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, valid_from)
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- PERIODS
-- ============================================================

CREATE TABLE periods (
  period char(7) PRIMARY KEY CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  locked_at timestamptz,
  locked_by uuid
);

-- ============================================================
-- DUES AND FINES
-- ============================================================

CREATE TABLE dues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text NOT NULL CHECK (kind IN ('monthly','start_boost','entry','levy')),
  shares_snapshot int NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa >= 0),
  due_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, period, kind)
);

CREATE TABLE fines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  due_id uuid REFERENCES dues,
  member_id uuid NOT NULL REFERENCES members,
  kind text NOT NULL DEFAULT 'late_payment' CHECK (kind IN ('late_payment','absence')),
  meeting_id uuid,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  reason text NOT NULL DEFAULT 'late_payment',
  waived_by_proposal uuid,
  waived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A late-payment fine always belongs to a due; an absence fine belongs to a meeting.
  CHECK (kind <> 'late_payment' OR due_id IS NOT NULL),
  CHECK (kind <> 'absence' OR meeting_id IS NOT NULL),
  CHECK ((waived_by_proposal IS NULL) = (waived_at IS NULL))
);

-- One fine per due, never compounding (5.5). due_id is nullable only for absence fines.
CREATE UNIQUE INDEX fines_one_per_due ON fines (due_id) WHERE due_id IS NOT NULL;

-- ============================================================
-- FILES
-- ============================================================

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 char(64) NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  path text NOT NULL,
  original_name text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- PAYMENTS
-- ============================================================

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  method text NOT NULL CHECK (method IN ('bkash','nagad','bank','cash','other')),
  purpose text NOT NULL DEFAULT 'dues'
    CHECK (purpose IN ('dues','entry','settlement_shortfall','levy')),
  trx_id text,
  paid_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','reversed')),
  source text NOT NULL CHECK (source IN ('member_submitted','cashier_entry','sms_match','import')),
  for_periods text[],
  proof_file_id uuid REFERENCES files,
  raw_sms text,
  note text,
  reject_reason text,
  unallocated_paisa bigint NOT NULL DEFAULT 0,
  submitted_by uuid,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  CHECK (unallocated_paisa >= 0 AND unallocated_paisa <= amount_paisa),
  CHECK (trx_id IS NULL OR length(btrim(trx_id)) > 0),
  CHECK ((status IN ('confirmed','reversed')) = (confirmed_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR length(btrim(coalesce(reject_reason, ''))) >= 3)
);

CREATE UNIQUE INDEX payments_trx_active ON payments (upper(trim(trx_id)))
  WHERE trx_id IS NOT NULL AND status IN ('pending','confirmed');

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments,
  due_id uuid REFERENCES dues,
  fine_id uuid REFERENCES fines,
  amount_paisa bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((due_id IS NULL) <> (fine_id IS NULL))
);

-- ============================================================
-- ACCOUNTS AND LEDGER
-- ============================================================

CREATE TABLE accounts (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('asset','liability','equity','income','expense')),
  is_cash boolean NOT NULL DEFAULT false
);

CREATE TABLE ledger_entries (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date date NOT NULL,
  debit_account text NOT NULL REFERENCES accounts,
  credit_account text NOT NULL REFERENCES accounts,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  member_id uuid,
  ref_type text,
  ref_id uuid,
  memo text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  prev_hash char(64) NOT NULL,
  hash char(64) NOT NULL UNIQUE,
  -- A correction is a NEW row that cancels an old one; it never edits or deletes it. The link is a
  -- column (so "already reversed" can be a unique index) and is also written into the hashed memo, so
  -- it is covered by the hash chain. The trigger below checks the reversal really mirrors its target.
  reverses_seq bigint REFERENCES ledger_entries (seq),
  CHECK (debit_account <> credit_account),
  -- COALESCE: a NULL memo would make the LIKE NULL, which a CHECK treats as passing.
  CHECK (reverses_seq IS NULL OR COALESCE(memo LIKE 'Reversal of #' || reverses_seq::text || ':%', false))
);

-- An entry can be reversed at most once.
CREATE UNIQUE INDEX ledger_one_reversal ON ledger_entries (reverses_seq) WHERE reverses_seq IS NOT NULL;

-- ============================================================
-- ASSETS
-- ============================================================

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('gold','land','house','other')),
  name text NOT NULL,
  description text,
  location text,
  acquired_on date,
  cost_paisa bigint NOT NULL DEFAULT 0,
  quantity numeric(14,4),
  unit text CHECK (unit IN ('vori','gram')),
  status text NOT NULL CHECK (status IN ('planned','acquiring','held','sold')),
  sold_on date,
  sale_price_paisa bigint,
  proposal_id uuid,
  legal_owner_name text,
  ownership_split jsonb,
  compliance jsonb,
  feasibility_file_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE asset_valuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets,
  value_paisa bigint NOT NULL,
  as_of date NOT NULL,
  basis text,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES files,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  doc_type text,
  title text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- RENT
-- ============================================================

CREATE TABLE rent_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid REFERENCES assets,
  name text NOT NULL,
  tenant_name text,
  monthly_amount_paisa bigint NOT NULL CHECK (monthly_amount_paisa > 0),
  due_day int NOT NULL CHECK (due_day BETWEEN 1 AND 28),
  active_from date NOT NULL,
  active_to date
);

CREATE TABLE rent_expected (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL REFERENCES rent_streams,
  period char(7) NOT NULL,
  amount_paisa bigint NOT NULL,
  due_date date NOT NULL,
  received_paisa bigint NOT NULL DEFAULT 0,
  UNIQUE (stream_id, period)
);

-- ============================================================
-- PROPOSALS AND VOTING
-- ============================================================

CREATE TABLE proposal_policies (
  type text PRIMARY KEY,
  basis text NOT NULL CHECK (basis IN ('member','share')),
  threshold_kind text NOT NULL CHECK (threshold_kind IN ('majority','unanimous')),
  amount_threshold_paisa bigint,
  clause_ref text,
  requires_feasibility boolean NOT NULL DEFAULT false
);

CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL REFERENCES proposal_policies,
  title text NOT NULL,
  description text,
  subject_member_id uuid,
  payload jsonb NOT NULL,
  amount_paisa bigint,
  clause_ref text,
  basis text NOT NULL DEFAULT 'member' CHECK (basis IN ('member','share')),
  threshold_kind text NOT NULL DEFAULT 'majority' CHECK (threshold_kind IN ('majority','unanimous')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','approved','rejected','executed','lapsed','cancelled')),
  created_by uuid NOT NULL,
  opens_at timestamptz,
  closes_at timestamptz,
  eligible_count int,
  eligible_weight bigint,
  threshold int,
  threshold_weight bigint,
  yes_count int NOT NULL DEFAULT 0,
  no_count int NOT NULL DEFAULT 0,
  abstain_count int NOT NULL DEFAULT 0,
  yes_weight bigint NOT NULL DEFAULT 0,
  no_weight bigint NOT NULL DEFAULT 0,
  abstain_weight bigint NOT NULL DEFAULT 0,
  finalized_at timestamptz,
  executed_at timestamptz,
  executed_by uuid,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proposal_voters (
  proposal_id uuid NOT NULL REFERENCES proposals,
  member_id uuid NOT NULL REFERENCES members,
  weight int NOT NULL DEFAULT 1,
  PRIMARY KEY (proposal_id, member_id)
);

CREATE TABLE votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals,
  member_id uuid NOT NULL REFERENCES members,
  choice text NOT NULL CHECK (choice IN ('yes','no','abstain')),
  cast_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

CREATE UNIQUE INDEX votes_current ON votes (proposal_id, member_id) WHERE superseded_at IS NULL;

-- ============================================================
-- APPROVALS
-- ============================================================

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL
    CHECK (kind IN ('payment_reversal','reconciliation','period_lock','annual_audit','inactive_declaration','death_surrender')),
  ref_id text NOT NULL,
  requested_by uuid NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Separation of duties: the requester (cashier) can never decide their own request.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

-- ============================================================
-- MEMBER STATUS AND SNAPSHOTS
-- ============================================================

CREATE TABLE member_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  from_status text,
  to_status text NOT NULL,
  reason text,
  proposal_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  kind text NOT NULL CHECK (kind IN ('suspension','settlement_quote')),
  taken_on date NOT NULL,
  shares int NOT NULL,
  net_assets_paisa bigint NOT NULL,
  shares_outstanding int NOT NULL,
  nav_per_share_paisa bigint NOT NULL,
  paid_in_capital_paisa bigint,
  gross_paisa bigint,
  escrow_paisa bigint,
  deductions jsonb NOT NULL DEFAULT '{}',
  net_paisa bigint,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entry_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  shares int NOT NULL,
  net_assets_paisa bigint NOT NULL,
  shares_outstanding int NOT NULL,
  price_paisa bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_contact_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  kind text NOT NULL CHECK (kind IN ('call','message','email','registered_letter','visit')),
  outcome text,
  note text,
  at timestamptz NOT NULL DEFAULT now(),
  by uuid NOT NULL
);

-- ============================================================
-- SETTLEMENTS
-- ============================================================

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  snapshot_id uuid NOT NULL REFERENCES member_snapshots,
  proposal_id uuid NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('early_exit','compassionate_exit','inactive_return','death_surrender','wind_up')),
  net_paisa bigint NOT NULL,
  payout_plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','paying','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE settlement_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES settlements,
  due_on date NOT NULL,
  amount_paisa bigint NOT NULL,
  paid_at timestamptz,
  ledger_seq bigint
);

CREATE TABLE financing_arrangements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES assets,
  counterparty text NOT NULL,
  description text NOT NULL,
  total_paisa bigint NOT NULL CHECK (total_paisa > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE financing_instalments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arrangement_id uuid NOT NULL REFERENCES financing_arrangements,
  due_on date NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  paid_at timestamptz,
  ledger_seq bigint
);


-- ============================================================
-- RECONCILIATION AND OBJECTIONS
-- ============================================================

CREATE TABLE reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period char(7) NOT NULL,
  account text NOT NULL REFERENCES accounts,
  system_balance_paisa bigint NOT NULL,
  actual_balance_paisa bigint NOT NULL,
  difference_paisa bigint GENERATED ALWAYS AS (actual_balance_paisa - system_balance_paisa) STORED,
  note text,
  submitted_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  UNIQUE (period, account),
  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),
  CHECK (difference_paisa = 0 OR length(btrim(coalesce(note, ''))) > 0)
);

CREATE TABLE objections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_seq bigint NOT NULL REFERENCES ledger_entries,
  member_id uuid NOT NULL REFERENCES members,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution text,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- ============================================================
-- CONSTITUTION
-- ============================================================

CREATE TABLE constitution_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  file_id uuid REFERENCES files,
  effective_from date NOT NULL,
  summary text,
  proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE constitution_clauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES constitution_versions,
  clause_no text NOT NULL,
  title text,
  summary text,
  body text,
  UNIQUE (version_id, clause_no)
);

CREATE TABLE constitution_acks (
  version_id uuid NOT NULL REFERENCES constitution_versions,
  member_id uuid NOT NULL REFERENCES members,
  acked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, member_id)
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members,
  template text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('push','sms')),
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  error text
);

-- ============================================================
-- AUDIT AND IDEMPOTENCY
-- ============================================================

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Keys are scoped per user so one user's key can never replay another user's response.
-- request_hash lets the API reject a reused key that arrives with a different body.
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  status_code int NOT NULL DEFAULT 200,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ============================================================
-- MEETINGS (18.7)
-- ============================================================

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_for timestamptz,
  link text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','held','cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fines ADD CONSTRAINT fines_meeting_fk FOREIGN KEY (meeting_id) REFERENCES meetings (id);

CREATE TABLE meeting_attendance (
  meeting_id uuid NOT NULL REFERENCES meetings,
  member_id uuid NOT NULL REFERENCES members,
  status text NOT NULL CHECK (status IN ('present','absent_excused','absent_unexcused')),
  reason text,
  PRIMARY KEY (meeting_id, member_id)
);

-- ============================================================
-- CHARITY DONATIONS (18.2)
-- ============================================================

CREATE TABLE charity_donations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals,
  recipient text NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  proof_file_id uuid REFERENCES files,
  donated_on date NOT NULL,
  ledger_seq bigint
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_dues_member_period ON dues(member_id, period);
CREATE INDEX idx_payments_member_status ON payments(member_id, status);
CREATE INDEX idx_payments_pending ON payments(submitted_at) WHERE status = 'pending';
CREATE INDEX idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_due ON payment_allocations(due_id) WHERE due_id IS NOT NULL;
CREATE INDEX idx_payment_allocations_fine ON payment_allocations(fine_id) WHERE fine_id IS NOT NULL;
CREATE INDEX idx_ledger_entry_date ON ledger_entries(entry_date);
CREATE INDEX idx_ledger_member ON ledger_entries(member_id);
CREATE INDEX idx_ledger_debit ON ledger_entries(debit_account);
CREATE INDEX idx_ledger_credit ON ledger_entries(credit_account);
CREATE INDEX idx_ledger_ref ON ledger_entries(ref_type, ref_id);
CREATE INDEX idx_notifications_member_template ON notifications(member_id, template, scheduled_for);
CREATE INDEX idx_notifications_queue ON notifications(scheduled_for) WHERE status = 'queued';
CREATE INDEX idx_fines_member ON fines(member_id);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_closing ON proposals(closes_at) WHERE status = 'open';
CREATE INDEX idx_votes_proposal ON votes(proposal_id);
CREATE INDEX idx_share_holdings_member ON share_holdings(member_id, effective_from);
CREATE INDEX idx_share_register_member ON share_register(member_id);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_devices_user ON devices(user_id);
CREATE UNIQUE INDEX idx_devices_refresh_hash ON devices(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX idx_activation_codes_user ON activation_codes(user_id, created_at DESC);
CREATE INDEX idx_device_events_at ON device_events(at DESC);
CREATE INDEX idx_settlement_payouts_settlement ON settlement_payouts(settlement_id);
CREATE INDEX idx_financing_instalments_arrangement ON financing_instalments(arrangement_id);
CREATE INDEX idx_objections_ledger ON objections(ledger_seq);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Today's business date. The database runs in UTC, so CURRENT_DATE would be wrong between
-- 00:00 and 06:00 Asia/Dhaka.
CREATE OR REPLACE FUNCTION today_dhaka() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date;
$$;

-- shares_on: sum of active share holdings for a member on a given date
CREATE OR REPLACE FUNCTION shares_on(p_member_id uuid, p_date date)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(shares), 0)::int
  FROM share_holdings
  WHERE member_id = p_member_id
    AND effective_from <= p_date
    AND (effective_to IS NULL OR effective_to > p_date);
$$;

-- get_rule: the rule value in force on a date (greatest valid_from <= as_of). NULL if none.
CREATE OR REPLACE FUNCTION get_rule(p_key text, p_as_of date)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT value FROM rules
  WHERE key = p_key AND valid_from <= p_as_of
  ORDER BY valid_from DESC
  LIMIT 1;
$$;

-- ============================================================
-- VIEWS
-- ============================================================

-- Account balances from ledger.
--   balance_paisa          = debits - credits (raw)
--   natural_balance_paisa  = positive in the account's normal direction
--                            (debit-normal: asset, expense; credit-normal: liability, equity, income)
-- NAV and reports must use natural_balance_paisa for liabilities (e.g. SETTLEMENT_PAYABLE).
CREATE OR REPLACE VIEW v_account_balances AS
SELECT
  a.code,
  a.name,
  a.kind,
  a.is_cash,
  COALESCE(d.total, 0) - COALESCE(c.total, 0) AS balance_paisa,
  CASE WHEN a.kind IN ('asset', 'expense')
    THEN COALESCE(d.total, 0) - COALESCE(c.total, 0)
    ELSE COALESCE(c.total, 0) - COALESCE(d.total, 0)
  END AS natural_balance_paisa
FROM accounts a
LEFT JOIN (SELECT debit_account AS code, SUM(amount_paisa) AS total
           FROM ledger_entries GROUP BY debit_account) d ON d.code = a.code
LEFT JOIN (SELECT credit_account AS code, SUM(amount_paisa) AS total
           FROM ledger_entries GROUP BY credit_account) c ON c.code = a.code;

-- Due status (5.3). Allocation rows are append-only and reversals are NEGATIVE rows, so outstanding
-- must sum every row (a reversal restores the outstanding principal).
--   overdue : outstanding > 0 and today (Asia/Dhaka) > due_date
--   paid_late: fully paid and the last positive allocation's payment date is after due_date
CREATE OR REPLACE VIEW v_due_status AS
WITH alloc AS (
  SELECT
    pa.due_id,
    SUM(pa.amount_paisa) AS allocated_paisa,
    MAX((p.paid_at AT TIME ZONE 'Asia/Dhaka')::date) FILTER (WHERE pa.amount_paisa > 0 AND p.status = 'confirmed') AS last_paid_on
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  WHERE pa.due_id IS NOT NULL
  GROUP BY pa.due_id
)
SELECT
  d.id AS due_id,
  d.member_id,
  d.period,
  d.kind,
  d.shares_snapshot,
  d.amount_paisa,
  d.due_date,
  COALESCE(al.allocated_paisa, 0) AS allocated_paisa,
  d.amount_paisa - COALESCE(al.allocated_paisa, 0) AS outstanding_paisa,
  CASE
    WHEN d.amount_paisa - COALESCE(al.allocated_paisa, 0) <= 0
      THEN CASE WHEN al.last_paid_on > d.due_date THEN 'paid_late' ELSE 'paid' END
    WHEN today_dhaka() > d.due_date THEN 'overdue'
    WHEN COALESCE(al.allocated_paisa, 0) > 0 THEN 'partial'
    ELSE 'unpaid'
  END AS status
FROM dues d
LEFT JOIN alloc al ON al.due_id = d.id;

-- Fine status (5.5): outstanding = amount - allocations - waived.
CREATE OR REPLACE VIEW v_fine_status AS
SELECT
  f.id AS fine_id,
  f.due_id,
  f.member_id,
  f.kind,
  f.amount_paisa,
  f.waived_at,
  COALESCE(al.allocated_paisa, 0) AS allocated_paisa,
  CASE WHEN f.waived_at IS NOT NULL THEN 0
       ELSE f.amount_paisa - COALESCE(al.allocated_paisa, 0) END AS outstanding_paisa
FROM fines f
LEFT JOIN (SELECT fine_id, SUM(amount_paisa) AS allocated_paisa
           FROM payment_allocations WHERE fine_id IS NOT NULL GROUP BY fine_id) al
  ON al.fine_id = f.id;

-- Member balances summary
CREATE OR REPLACE VIEW v_member_balances AS
SELECT
  m.id AS member_id,
  m.full_name,
  m.status,
  COALESCE(SUM(CASE WHEN le.credit_account = 'MEMBER_CAPITAL' THEN le.amount_paisa ELSE 0 END), 0)
  - COALESCE(SUM(CASE WHEN le.debit_account = 'MEMBER_CAPITAL' THEN le.amount_paisa ELSE 0 END), 0)
    AS capital_paisa
FROM members m
LEFT JOIN ledger_entries le ON le.member_id = m.id
  AND (le.debit_account = 'MEMBER_CAPITAL' OR le.credit_account = 'MEMBER_CAPITAL')
GROUP BY m.id, m.full_name, m.status;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Forbid mutation on append-only tables
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

-- Forbid deletes only (rows with a controlled lifecycle: they may change state, never disappear)
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER no_mutation_ledger BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_audit BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_allocations BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_snapshots BEFORE UPDATE OR DELETE ON member_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_valuations BEFORE UPDATE OR DELETE ON asset_valuations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_rules BEFORE UPDATE OR DELETE ON rules
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_status_events BEFORE UPDATE OR DELETE ON member_status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_dues BEFORE UPDATE OR DELETE ON dues
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_device_events BEFORE UPDATE OR DELETE ON device_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_mutation_charity BEFORE UPDATE OR DELETE ON charity_donations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ROW triggers do not fire for TRUNCATE; without these a TRUNCATE would silently erase the ledger.
CREATE TRIGGER no_truncate_ledger BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_audit BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_allocations BEFORE TRUNCATE ON payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_snapshots BEFORE TRUNCATE ON member_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_valuations BEFORE TRUNCATE ON asset_valuations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_rules BEFORE TRUNCATE ON rules
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_status_events BEFORE TRUNCATE ON member_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_votes BEFORE TRUNCATE ON votes
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_payments BEFORE TRUNCATE ON payments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Financial and governance records change state but are never deleted ("corrections are reversals").
CREATE TRIGGER no_delete_members BEFORE DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_payments BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_fines BEFORE DELETE ON fines
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_assets BEFORE DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_files BEFORE DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_documents BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_proposals BEFORE DELETE ON proposals
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_proposal_voters BEFORE DELETE ON proposal_voters
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_settlements BEFORE DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_settlement_payouts BEFORE DELETE ON settlement_payouts
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_financing_arrangements BEFORE DELETE ON financing_arrangements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_financing_instalments BEFORE DELETE ON financing_instalments
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_reconciliations BEFORE DELETE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_objections BEFORE DELETE ON objections
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_approvals BEFORE DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_rent_expected BEFORE DELETE ON rent_expected
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_share_holdings BEFORE DELETE ON share_holdings
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER no_delete_constitution_versions BEFORE DELETE ON constitution_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Payments: core facts are immutable; only the lifecycle fields may change, along legal transitions
-- pending -> confirmed | rejected, confirmed -> reversed.
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.amount_paisa IS DISTINCT FROM OLD.amount_paisa
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.trx_id IS DISTINCT FROM OLD.trx_id
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.raw_sms IS DISTINCT FROM OLD.raw_sms
    OR NEW.proof_file_id IS DISTINCT FROM OLD.proof_file_id
    OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'payment % core fields are immutable', OLD.id;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'rejected'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'reversed')
  ) THEN
    RAISE EXCEPTION 'illegal payment status transition % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard();

-- Fines: only the waiver columns may change, and only once (5.5).
CREATE OR REPLACE FUNCTION fines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.due_id IS DISTINCT FROM OLD.due_id
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
    OR NEW.amount_paisa IS DISTINCT FROM OLD.amount_paisa
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'fine % core fields are immutable', OLD.id;
  END IF;
  IF OLD.waived_at IS NOT NULL AND (
       NEW.waived_at IS DISTINCT FROM OLD.waived_at
    OR NEW.waived_by_proposal IS DISTINCT FROM OLD.waived_by_proposal) THEN
    RAISE EXCEPTION 'fine % is already waived', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fines_guard BEFORE UPDATE ON fines
  FOR EACH ROW EXECUTE FUNCTION fines_guard();

-- Payment allocations: bounds and ownership.
--   * allocations only attach to confirmed (or reversed) payments
--   * the due/fine must belong to the payment's member
--   * per payment: 0 <= sum <= payment amount; per due/fine: 0 <= sum <= amount
-- The parent rows are locked FOR UPDATE so two concurrent confirmations cannot both over-allocate.
CREATE OR REPLACE FUNCTION check_allocation_bounds() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_pay_member uuid;
  v_pay_amount bigint;
  v_pay_status text;
  v_target_member uuid;
  v_target_amount bigint;
  v_total bigint;
BEGIN
  SELECT member_id, amount_paisa, status INTO v_pay_member, v_pay_amount, v_pay_status
  FROM payments WHERE id = NEW.payment_id FOR UPDATE;

  IF v_pay_status NOT IN ('confirmed', 'reversed') THEN
    RAISE EXCEPTION 'cannot allocate payment % in status %', NEW.payment_id, v_pay_status;
  END IF;

  SELECT COALESCE(SUM(amount_paisa), 0) INTO v_total
  FROM payment_allocations WHERE payment_id = NEW.payment_id;
  IF v_total < 0 OR v_total > v_pay_amount THEN
    RAISE EXCEPTION 'allocations for payment % out of bounds (% of %)', NEW.payment_id, v_total, v_pay_amount;
  END IF;

  IF NEW.due_id IS NOT NULL THEN
    SELECT member_id, amount_paisa INTO v_target_member, v_target_amount
    FROM dues WHERE id = NEW.due_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_paisa), 0) INTO v_total
    FROM payment_allocations WHERE due_id = NEW.due_id;
  ELSE
    SELECT member_id, amount_paisa INTO v_target_member, v_target_amount
    FROM fines WHERE id = NEW.fine_id FOR UPDATE;
    SELECT COALESCE(SUM(amount_paisa), 0) INTO v_total
    FROM payment_allocations WHERE fine_id = NEW.fine_id;
  END IF;

  IF v_target_member IS DISTINCT FROM v_pay_member THEN
    RAISE EXCEPTION 'allocation member mismatch for payment %', NEW.payment_id;
  END IF;
  IF v_total < 0 OR v_total > v_target_amount THEN
    RAISE EXCEPTION 'allocations for due/fine out of bounds (% of %)', v_total, v_target_amount;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER allocation_bounds AFTER INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION check_allocation_bounds();

-- Votes: only superseded_at may change
CREATE OR REPLACE FUNCTION votes_immutable_except_superseded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.proposal_id <> OLD.proposal_id
    OR NEW.member_id <> OLD.member_id
    OR NEW.choice <> OLD.choice
    OR NEW.cast_at <> OLD.cast_at
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'votes are immutable except superseded_at';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER votes_protect BEFORE UPDATE ON votes
  FOR EACH ROW EXECUTE FUNCTION votes_immutable_except_superseded();

CREATE TRIGGER no_delete_votes BEFORE DELETE ON votes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Ledger hash chain.
--
-- Ordering matters: the identity value (seq) is assigned while the row is being built, which is BEFORE
-- any row trigger runs. If the chain lock were taken only in the row trigger, a transaction holding
-- seq 5 could acquire the lock after the one holding seq 6, and the chain (commit order) would no
-- longer follow seq order. Taking the lock in a BEFORE STATEMENT trigger acquires it before nextval().
CREATE OR REPLACE FUNCTION ledger_lock_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7001);
  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_lock_stmt BEFORE INSERT ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_lock_chain();

CREATE OR REPLACE FUNCTION ledger_hash_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_prev_hash char(64);
  v_canonical text;
  v_orig ledger_entries%ROWTYPE;
BEGIN
  -- The "last row" read below must see every committed row; a REPEATABLE READ/SERIALIZABLE snapshot
  -- taken before the lock would not, and would fork the chain.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ledger postings require READ COMMITTED isolation (got %)',
      current_setting('transaction_isolation');
  END IF;

  -- Re-entrant; also protects callers that bypass the statement trigger (e.g. COPY).
  PERFORM pg_advisory_xact_lock(7001);

  SELECT hash INTO v_prev_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1;
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);
  END IF;

  -- A reversal must exactly mirror an existing original: opposite accounts, same amount, same member,
  -- and the original must not itself be a reversal (post a fresh entry instead of reversing twice).
  IF NEW.reverses_seq IS NOT NULL THEN
    SELECT * INTO v_orig FROM ledger_entries WHERE seq = NEW.reverses_seq;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ledger entry % to reverse does not exist', NEW.reverses_seq;
    END IF;
    IF v_orig.reverses_seq IS NOT NULL THEN
      RAISE EXCEPTION 'ledger entry % is itself a reversal and cannot be reversed', v_orig.seq;
    END IF;
    IF NEW.debit_account <> v_orig.credit_account
       OR NEW.credit_account <> v_orig.debit_account
       OR NEW.amount_paisa <> v_orig.amount_paisa
       OR NEW.member_id IS DISTINCT FROM v_orig.member_id THEN
      RAISE EXCEPTION 'reversal of ledger entry % does not mirror the original', v_orig.seq;
    END IF;
  END IF;

  NEW.prev_hash := v_prev_hash;

  -- Canonical form (spec 5.6). Dates/timestamps use explicit formats so the result never depends on
  -- DateStyle or the session time zone. apps/api/src/lib/ledger-chain.ts recomputes this byte for byte.
  v_canonical := concat_ws('|',
    NEW.seq,
    to_char(NEW.entry_date, 'YYYY-MM-DD'),
    NEW.debit_account,
    NEW.credit_account,
    NEW.amount_paisa,
    COALESCE(NEW.member_id::text, ''),
    COALESCE(NEW.ref_type, ''),
    COALESCE(NEW.ref_id::text, ''),
    COALESCE(NEW.memo, ''),
    COALESCE(NEW.created_by::text, ''),
    to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  NEW.hash := encode(digest(v_prev_hash || '|' || v_canonical, 'sha256'), 'hex');

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_before_insert BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_hash_chain();

-- Reject ledger entries in locked periods
CREATE OR REPLACE FUNCTION reject_locked_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_period char(7);
BEGIN
  v_period := to_char(NEW.entry_date, 'YYYY-MM');
  IF EXISTS (SELECT 1 FROM periods WHERE period = v_period AND locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Period % is locked', v_period;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_check_period BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_locked_period();

-- Retired accounts (18.2): fines are charity money, so FINE_INCOME stays as a row for legacy
-- compatibility but accepts no new postings.
CREATE OR REPLACE FUNCTION reject_retired_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.debit_account = 'FINE_INCOME' OR NEW.credit_account = 'FINE_INCOME' THEN
    RAISE EXCEPTION 'FINE_INCOME is retired: post fines to CHARITY_PAYABLE (spec 18.2)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_check_accounts BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_retired_accounts();

-- ============================================================
-- SEED ACCOUNTS
-- ============================================================

INSERT INTO accounts (code, name, kind, is_cash) VALUES
  ('CASH', 'Cash in Hand', 'asset', true),
  ('BANK', 'Bank Account', 'asset', true),
  ('BKASH', 'bKash Account', 'asset', true),
  ('NAGAD', 'Nagad Account', 'asset', true),
  ('INVESTMENTS_AT_COST', 'Investments at Cost', 'asset', false),
  ('MEMBER_CAPITAL', 'Member Capital', 'equity', false),
  ('OPENING_ADJUSTMENT', 'Opening Adjustment', 'equity', false),
  ('SETTLEMENT_PAYABLE', 'Settlement Payable', 'liability', false),
  ('MEMBER_ESCROW', 'Member Escrow', 'liability', false),
  ('CHARITY_PAYABLE', 'Charity Payable', 'liability', false),
  ('LEVY_CLEARING', 'Levy Clearing', 'liability', false),
  ('INACTIVE_HELD', 'Inactive Member Held', 'liability', false),
  ('MEMBER_QARD', 'Member Qard', 'liability', false),
  ('DEFERRED_PURCHASE_PAYABLE', 'Deferred Purchase Payable', 'liability', false),
  ('FINE_INCOME', 'Fine Income (legacy)', 'income', false),
  ('RENT_INCOME', 'Rent Income', 'income', false),
  ('BANK_PROFIT', 'Bank Profit (permitted)', 'income', false),
  ('ASSET_GAIN', 'Asset Gain', 'income', false),
  ('OTHER_INCOME', 'Other Income', 'income', false),
  ('EXIT_FEE_INCOME', 'Exit Fee Income', 'income', false),
  ('BANK_CHARGE', 'Bank Charge', 'expense', false),
  ('SMS_CHARGE', 'SMS Charge', 'expense', false),
  ('MAINTENANCE', 'Maintenance', 'expense', false),
  ('ASSET_LOSS', 'Asset Loss', 'expense', false),
  ('OTHER_EXPENSE', 'Other Expense', 'expense', false),
  ('DISTRIBUTIONS', 'Distributions', 'expense', false);

-- ============================================================
-- SEED PROPOSAL POLICIES (18.3)
-- ============================================================

-- 'expense' is member-basis below amount_threshold_paisa and share-basis at or above it (18.3, 4.2).
-- The threshold mirrors rule big_financial_threshold_paisa; the proposal service copies the policy at
-- open time, so later edits never change an open vote.
INSERT INTO proposal_policies (type, basis, threshold_kind, clause_ref, requires_feasibility) VALUES
  ('general', 'member', 'majority', '4.1', false),
  ('role_change', 'member', 'majority', '4.1', false),
  ('rule_change', 'member', 'majority', '4.1', false),
  ('reinstatement', 'member', 'majority', '4.1', false),
  ('fine_waiver', 'member', 'majority', '4.1', false),
  ('charity_donation', 'member', 'majority', '4.1', false),
  ('investment_purchase', 'share', 'majority', '4.2', true),
  ('asset_sale', 'share', 'majority', '4.2', false),
  ('distribution', 'share', 'majority', '4.2', false),
  ('valuation_update', 'share', 'majority', '4.2', false),
  ('financing_arrangement', 'share', 'majority', '6.3', false),
  ('dissolution', 'share', 'majority', '10.2', false),
  ('wind_up', 'share', 'majority', '10.2', false),
  ('new_member', 'member', 'unanimous', '5.3', false),
  ('contribution_change', 'member', 'unanimous', '1.4', false),
  ('constitution_amendment', 'member', 'unanimous', NULL, false),
  ('settlement', 'member', 'majority', '5.1', false),
  ('suspension', 'member', 'majority', '2.4', false),
  ('member_deceased', 'member', 'majority', '8', false),
  ('asset_cost_levy', 'member', 'majority', '6.2', false),
  ('member_qard', 'member', 'majority', '6.3', false),
  ('land_selection', 'share', 'majority', '4.2', false),
  ('project_closure', 'share', 'majority', '4.2', false);

INSERT INTO proposal_policies (type, basis, threshold_kind, amount_threshold_paisa, clause_ref) VALUES
  ('expense', 'member', 'majority', 10000000, '4.1');

-- ============================================================
-- SEED DEFAULT RULES (5.2 + 18.1)
-- ============================================================

INSERT INTO rules (key, value, valid_from, clause_ref) VALUES
  ('monthly_due_per_share_paisa', '500000', '2026-01-01', '1.4'),
  ('start_boost_per_share_paisa', '800000', '2026-01-01', '1.4'),
  ('due_day', '20', '2026-01-01', '2.1'),
  ('dues_generation_day', '1', '2026-01-01', NULL),
  ('reminder_start_day', '15', '2026-01-01', NULL),
  ('reminder_end_day', '20', '2026-01-01', NULL),
  ('reminder_time', '"09:00"', '2026-01-01', NULL),
  ('fine_day', '21', '2026-01-01', '2.2'),
  ('fine_per_share_paisa', '50000', '2026-01-01', '2.2'),
  ('warning_after_months', '2', '2026-01-01', NULL),
  ('suspension_after_consecutive_unpaid_months', '3', '2026-01-01', '2.4'),
  ('final_notice_days', '7', '2026-01-01', '2.4'),
  ('auto_suspend', 'true', '2026-01-01', '2.4'),
  ('push_to_sms_fallback_hours', '6', '2026-01-01', NULL),
  ('default_vote_duration_hours', '72', '2026-01-01', NULL),
  ('proposal_execution_window_days', '30', '2026-01-01', NULL),
  ('payment_pending_alert_hours', '24', '2026-01-01', NULL),
  ('rent_grace_days', '3', '2026-01-01', NULL),
  ('valuation_max_age_days', '365', '2026-01-01', NULL),
  ('exit_fee_paisa', '0', '2026-01-01', NULL),
  ('early_exit_service_charge_percent', '10', '2026-01-01', '5.1'),
  ('allocation_order', '"oldest_principal_then_fines"', '2026-01-01', NULL),
  ('fund_term_start', '"2026-01-01"', '2026-01-01', '1.2'),
  ('fund_term_end', '"2028-12-31"', '2026-01-01', '1.2'),
  ('feasibility_threshold_paisa', '10000000', '2026-01-01', '12.2'),
  ('big_financial_threshold_paisa', '10000000', '2026-01-01', '4.2'),
  ('absence_fine_paisa', '50000', '2026-01-01', '9.2'),
  ('absence_fine_after_consecutive', '3', '2026-01-01', '9.2'),
  ('meeting_window_start_day', '10', '2026-01-01', '9.1'),
  ('meeting_window_end_day', '12', '2026-01-01', '9.1'),
  ('inactive_after_months_no_contact', '3', '2026-01-01', '13.1'),
  ('inactive_wait_days_after_letter', '30', '2026-01-01', '13.2'),
  ('compliance.interest_free', 'true', '2026-01-01', '3.1'),
  ('max_devices_per_member', '1', '2026-01-01', NULL),
  ('max_devices_privileged', '2', '2026-01-01', NULL),
  ('reinstatement_charges_fines', 'false', '2026-01-01', NULL);

-- ============================================================
-- SEED DEFAULT SETTINGS
-- ============================================================

INSERT INTO settings (key, value) VALUES
  ('fund_name', '"বারাকাহ ফান্ড"'),
  ('payment_instructions', '{"bkash":"+8801XXXXXXXXX","nagad":"+8801XXXXXXXXX","bank":"Bank Name, A/C: XXXXXXXXXX"}'),
  ('sms_enabled', 'false'),
  ('apk_download_url', '""'),
  ('app_min_version', '"1.0.0"'),
  ('app_latest_version', '"1.0.0"');

-- ============================================================
-- GRANTS (spec section 6: three database roles)
-- ============================================================
-- barakah_migrator owns the objects and runs migrations. The app and read-only roles are created by the
-- infra bootstrap (infra/initdb/10-roles.sh) before migrations run; when they do not exist (e.g. a bare
-- test database) this block is skipped.

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT USAGE ON SCHEMA public TO barakah_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO barakah_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO barakah_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO barakah_app;
    -- DELETE only where the lifecycle genuinely purges rows (cleanup job).
    GRANT DELETE ON idempotency_keys, activation_codes TO barakah_app;

    -- pg-boss job queue runs in its own schema and the app role creates its own objects there.
    CREATE SCHEMA IF NOT EXISTS pgboss;
    GRANT USAGE, CREATE ON SCHEMA pgboss TO barakah_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO barakah_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO barakah_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO barakah_app;
    -- Append-only tables: no UPDATE/DELETE/TRUNCATE for the app (triggers enforce this for everyone).
    REVOKE UPDATE ON ledger_entries, audit_log, payment_allocations, member_snapshots,
      asset_valuations, rules, member_status_events, device_events, charity_donations FROM barakah_app;
    -- Future migrations: new tables are readable/insertable by the app; tighten per table as needed.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO barakah_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO barakah_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT USAGE ON SCHEMA public TO barakah_readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO barakah_readonly;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO barakah_readonly;
    -- Credentials and secrets are never readable by the verifier/backup-check role.
    REVOKE SELECT ON users, devices, activation_codes, idempotency_keys FROM barakah_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
-- The baseline schema holds financial records and is intentionally irreversible.
DO $$ BEGIN
  RAISE EXCEPTION 'Migration 001 is irreversible. Restore from backup instead.';
END $$;
