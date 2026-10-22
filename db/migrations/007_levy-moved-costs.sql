-- Up Migration
-- Bank and SMS charges taken from the main fund before the levy fund existed can be moved onto the
-- levy fund once (ASSUMPTIONS 106): a new entry `DR LEVY_CLEARING, CR <charge account>`; the old
-- entry stays as it is. This column names the entry that was moved, so it can never be moved twice.
ALTER TABLE levy_expenses ADD COLUMN moved_from_seq bigint UNIQUE;

-- Down Migration
ALTER TABLE levy_expenses DROP COLUMN moved_from_seq;
