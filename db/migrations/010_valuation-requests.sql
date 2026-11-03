-- Up Migration
-- 010: a responsible member per investment partner, and value updates sent for review (ASSUMPTIONS 115).
-- Owner decision: a rise in a shop's value is approved by the auditor; a fall, a rise of more than 10%,
-- or an update that concerns the auditor goes to the members' vote (the existing valuation_update
-- proposal). Only new tables and columns, so it is a separate migration (Doc.md 18.8).

-- Who looks after the investment and sends its value updates. Changing it is audited (partner.update).
ALTER TABLE investment_partners ADD COLUMN custodian_member_id uuid REFERENCES members;

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
  'payment_reversal','reconciliation','period_lock','annual_audit','inactive_declaration','death_surrender',
  'valuation_update'));
-- Why the auditor declined, so the person who sent it can read it (the audit log keeps it too).
ALTER TABLE approvals ADD COLUMN decision_note text;

-- One row per update sent. Never changed afterwards: its outcome is the approval it created (route
-- 'auditor', approvals.ref_id = this id) or the proposal (route 'vote').
CREATE TABLE valuation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES investment_partners,
  -- The shop's value when the update was sent (latest valuation or cost of each purchase not sold).
  -- Approval re-checks it, so an update made against an older value cannot be applied.
  base_value_paisa bigint NOT NULL CHECK (base_value_paisa >= 0),
  new_value_paisa bigint NOT NULL CHECK (new_value_paisa >= 0),
  as_of date NOT NULL,
  note text,
  proof_file_id uuid NOT NULL REFERENCES files,
  -- The new value spread over the purchases in proportion to cost: [{asset_id, value_paisa}].
  items jsonb NOT NULL,
  route text NOT NULL CHECK (route IN ('auditor','vote')),
  proposal_id uuid REFERENCES proposals,
  requested_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((route = 'vote') = (proposal_id IS NOT NULL))
);
CREATE INDEX valuation_requests_partner_idx ON valuation_requests (partner_id, created_at DESC);

CREATE TRIGGER no_mutation_valuation_requests BEFORE UPDATE OR DELETE ON valuation_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_valuation_requests BEFORE TRUNCATE ON valuation_requests
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- A valuation now comes from a passed proposal or from an approved request.
ALTER TABLE asset_valuations ADD COLUMN approval_id uuid REFERENCES approvals;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT ON valuation_requests TO barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON valuation_requests TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
ALTER TABLE asset_valuations DROP COLUMN IF EXISTS approval_id;
DROP TABLE IF EXISTS valuation_requests;
ALTER TABLE approvals DROP COLUMN IF EXISTS decision_note;
ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN (
  'payment_reversal','reconciliation','period_lock','annual_audit','inactive_declaration','death_surrender'));
ALTER TABLE investment_partners DROP COLUMN IF EXISTS custodian_member_id;
