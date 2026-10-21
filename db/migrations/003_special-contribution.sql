-- Up Migration
-- 003: Special contribution (constitution 1.4 "boosting"): a one-off amount per share that every member
-- pays into the fund's capital by a due date, for example to buy land. It is a due kind of its own, so it
-- never mixes with the monthly dues: it is never fined, it does not count towards warning or suspension,
-- and a monthly payment is never applied to it. Only widens two CHECKs and adds one policy row, so it is
-- safe on a database that already ran 001 (Doc.md 18.8).

ALTER TABLE dues DROP CONSTRAINT dues_kind_check;
ALTER TABLE dues ADD CONSTRAINT dues_kind_check
  CHECK (kind IN ('monthly','start_boost','entry','levy','special'));

ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check
  CHECK (purpose IN ('dues','entry','settlement_shortfall','levy','special'));

-- Changing what every share pays needs everyone's consent (constitution 1.4), like contribution_change.
INSERT INTO proposal_policies (type, basis, threshold_kind, clause_ref, requires_feasibility) VALUES
  ('special_contribution', 'member', 'unanimous', '1.4', false);

-- Down Migration
DELETE FROM proposal_policies WHERE type = 'special_contribution';
ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check
  CHECK (purpose IN ('dues','entry','settlement_shortfall','levy'));
ALTER TABLE dues DROP CONSTRAINT dues_kind_check;
ALTER TABLE dues ADD CONSTRAINT dues_kind_check
  CHECK (kind IN ('monthly','start_boost','entry','levy'));
