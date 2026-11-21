-- Up Migration
-- 014: the month-end check covers the shops too, and can carry the statement it was read from
-- (ASSUMPTIONS 132, owner request). New table and columns only, so it is a separate migration (Doc.md 18.8).

-- The bank statement (or photo of the cash) the count was read from.
ALTER TABLE reconciliations ADD COLUMN proof_file_id uuid REFERENCES files;

-- One row per shop per month: what the books say was sent to the shop that month (purchases, net of
-- reversals) against what the shop's own statement shows it received. Re-submitted until the auditor
-- approves, like the cash rows.
CREATE TABLE reconciliation_shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period char(7) NOT NULL,
  partner_id uuid NOT NULL REFERENCES investment_partners,
  system_sent_paisa bigint NOT NULL,
  statement_paisa bigint NOT NULL,
  difference_paisa bigint GENERATED ALWAYS AS (statement_paisa - system_sent_paisa) STORED,
  note text,
  proof_file_id uuid REFERENCES files,
  submitted_by uuid NOT NULL REFERENCES users,
  approved_by uuid REFERENCES users,
  approved_at timestamptz,
  UNIQUE (period, partner_id),
  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),
  CHECK (difference_paisa = 0 OR length(btrim(coalesce(note, ''))) > 0)
);
CREATE TRIGGER no_delete_reconciliation_shops BEFORE DELETE ON reconciliation_shops
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT, UPDATE ON reconciliation_shops TO barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON reconciliation_shops TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
DROP TABLE IF EXISTS reconciliation_shops;
ALTER TABLE reconciliations DROP COLUMN IF EXISTS proof_file_id;
