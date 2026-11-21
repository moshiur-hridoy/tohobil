-- Up Migration
-- 013: a standing investment approval (ASSUMPTIONS 131, owner decision). The members vote once that up
-- to a set amount a month goes to one shop for a set number of months; each month's purchase is then
-- recorded by the cashier without a new vote, with its receipt, and checked by the auditor at month
-- end. A member may also send their dues straight to that shop. New tables and columns only, so it is
-- a separate migration (Doc.md 18.8).

CREATE TABLE investment_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL UNIQUE REFERENCES proposals,
  partner_id uuid NOT NULL REFERENCES investment_partners,
  monthly_max_paisa bigint NOT NULL CHECK (monthly_max_paisa > 0),
  first_period text NOT NULL CHECK (first_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  last_period text NOT NULL CHECK (last_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- The investment checklist the members voted on, copied to every purchase made under it.
  compliance jsonb NOT NULL,
  -- Ending early (cashier or auditor) only narrows what the vote allowed, so it needs no vote.
  ended_on date,
  ended_by uuid REFERENCES users,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_period >= first_period),
  CHECK ((ended_on IS NULL) = (ended_by IS NULL) AND (ended_on IS NULL) = (end_reason IS NULL))
);
CREATE INDEX investment_mandates_partner_idx ON investment_mandates (partner_id);

-- Only the end columns may change, and only once.
CREATE OR REPLACE FUNCTION investment_mandates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_on IS NOT NULL
    OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
    OR NEW.monthly_max_paisa IS DISTINCT FROM OLD.monthly_max_paisa
    OR NEW.first_period IS DISTINCT FROM OLD.first_period
    OR NEW.last_period IS DISTINCT FROM OLD.last_period
    OR NEW.compliance IS DISTINCT FROM OLD.compliance
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'investment mandate % can only be ended, once', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER investment_mandates_guard BEFORE UPDATE ON investment_mandates
  FOR EACH ROW EXECUTE FUNCTION investment_mandates_guard();
CREATE TRIGGER no_delete_investment_mandates BEFORE DELETE ON investment_mandates
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Each purchase under a mandate is its own asset row (as every shop purchase is); a member's payment
-- sent straight to the shop also points at that payment.
ALTER TABLE assets ADD COLUMN mandate_id uuid REFERENCES investment_mandates;
ALTER TABLE assets ADD COLUMN payment_id uuid UNIQUE REFERENCES payments;
CREATE INDEX assets_mandate_idx ON assets (mandate_id, acquired_on);

-- The shop a member sent the money to, instead of the fund's own account. Part of the payment's facts.
ALTER TABLE payments ADD COLUMN partner_id uuid REFERENCES investment_partners;

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
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.partner_id IS DISTINCT FROM OLD.partner_id THEN
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

-- A purchase the cashier recorded by mistake is reversed by the auditor, like a payment.
ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
  'payment_reversal','reconciliation','period_lock','annual_audit','inactive_declaration','death_surrender',
  'valuation_update','mandate_purchase_reversal'));

INSERT INTO proposal_policies (type, basis, threshold_kind, clause_ref, requires_feasibility) VALUES
  ('investment_mandate', 'member', 'majority', '12.2', false);

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT, UPDATE ON investment_mandates TO barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON investment_mandates TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
DELETE FROM proposal_policies WHERE type = 'investment_mandate';
ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
  'payment_reversal','reconciliation','period_lock','annual_audit','inactive_declaration','death_surrender',
  'valuation_update'));
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
ALTER TABLE payments DROP COLUMN IF EXISTS partner_id;
DROP INDEX IF EXISTS assets_mandate_idx;
ALTER TABLE assets DROP COLUMN IF EXISTS payment_id;
ALTER TABLE assets DROP COLUMN IF EXISTS mandate_id;
DROP TABLE IF EXISTS investment_mandates;
DROP FUNCTION IF EXISTS investment_mandates_guard();
