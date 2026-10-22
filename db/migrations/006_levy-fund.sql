-- Up Migration
-- The levy becomes the fund's running-cost pot (owner decision, ASSUMPTIONS 105): bank and SMS
-- charges, photocopies, registration and VAT are paid from LEVY_CLEARING, never from members'
-- capital and never from charity. Each payment keeps its category, payee and receipt here; the
-- money itself is the ledger row `DR LEVY_CLEARING, CR <cash account>` (ref_type 'levy_expense').
CREATE TABLE levy_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('bank_charge', 'sms_charge', 'photocopy', 'registration', 'other')),
  payee text NOT NULL,
  note text NOT NULL,
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  receipt_file_id uuid REFERENCES files,
  -- Set when the expense was over the no-vote limit and went through an `expense` proposal.
  proposal_id uuid REFERENCES proposals,
  -- No foreign key, like charity_donations: one on ledger_entries would let TRUNCATE fail with a
  -- foreign-key error before the append-only trigger can say why.
  ledger_seq bigint NOT NULL UNIQUE,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER no_mutation_levy_expenses BEFORE UPDATE OR DELETE ON levy_expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The cashier records a levy expense up to this amount without a vote; above it, an `expense`
-- proposal paid from the levy fund is needed. 1,000 BDT.
INSERT INTO rules (key, value, valid_from, clause_ref)
VALUES ('levy_expense_max_without_vote_paisa', '100000', '2026-01-01', NULL);

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT ON levy_expenses TO barakah_app;
    REVOKE UPDATE ON levy_expenses FROM barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON levy_expenses TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
DELETE FROM rules WHERE key = 'levy_expense_max_without_vote_paisa';
DROP TABLE levy_expenses;
