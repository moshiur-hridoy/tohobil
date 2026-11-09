-- Up Migration
-- 011: remarks on ledger entries (owner request, ASSUMPTIONS 128). The cashier or the auditor can write
-- a short remark on any entry afterwards (a gold purchase, a payment, anything), to remember why it
-- happened. The ledger row itself is never touched and remarks are outside the hash chain. Remarks are
-- append-only: to "edit" one, a newer remark is added; the newest is the one shown, and the earlier
-- ones stay as its history. Only a new table, so it is a separate migration (Doc.md 18.8).

CREATE TABLE entry_remarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_seq bigint NOT NULL REFERENCES ledger_entries (seq),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_entry_remarks_seq ON entry_remarks (ledger_seq, created_at DESC);

CREATE TRIGGER no_mutation_entry_remarks BEFORE UPDATE OR DELETE ON entry_remarks
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_entry_remarks BEFORE TRUNCATE ON entry_remarks
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT ON entry_remarks TO barakah_app;
    REVOKE UPDATE ON entry_remarks FROM barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON entry_remarks TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
DROP TABLE IF EXISTS entry_remarks;
