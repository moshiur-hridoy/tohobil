-- Up Migration
-- Whether each cash account (cash, bank, bKash, Nagad) is tracked on its own for payouts and on the
-- dashboard. Off by default: the fund shows one pool and a payout is posted against BANK.
INSERT INTO rules (key, value, valid_from, clause_ref)
VALUES ('cash_tracking_by_method', 'false', '2026-01-01', NULL);

-- Down Migration
DELETE FROM rules WHERE key = 'cash_tracking_by_method';
