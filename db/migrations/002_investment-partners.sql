-- Up Migration
-- 002: Investment partners (a shop the fund invests with, such as a jeweller) and their contract terms.
-- A new table plus one nullable column: safe on a database that already ran 001, so it is a separate
-- migration rather than folded into 001 (Doc.md 18.8), because 001 may already have been applied.

CREATE TABLE investment_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('gold','land','house','other')),
  name text NOT NULL UNIQUE,
  contract_date date,
  -- The agreed profit or loss rate and how often it is settled (for example 3 months).
  rate_percent numeric(6,2) CHECK (rate_percent IS NULL OR rate_percent >= 0),
  period_months int CHECK (period_months IS NULL OR period_months > 0),
  -- How profit and loss are shared among the members, and anything else the contract says.
  sharing_policy text,
  contract_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE assets ADD COLUMN partner_id uuid REFERENCES investment_partners;
CREATE INDEX assets_partner_idx ON assets (partner_id);

CREATE TRIGGER no_delete_investment_partners BEFORE DELETE ON investment_partners
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT, UPDATE ON investment_partners TO barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON investment_partners TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
DROP INDEX IF EXISTS assets_partner_idx;
ALTER TABLE assets DROP COLUMN IF EXISTS partner_id;
DROP TABLE IF EXISTS investment_partners;
