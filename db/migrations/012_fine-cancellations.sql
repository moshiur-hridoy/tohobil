-- Up Migration
-- 012: a late fine is cancelled when the money had in fact arrived on time but was recorded after the
-- fine job ran (ASSUMPTIONS 130). Fines are never changed or deleted, so a cancellation is its own
-- insert-only row; it holds only while the payment that proved it stays confirmed and the due stays
-- paid, so reversing that payment brings the fine back with no further write.

CREATE TABLE fine_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fine_id uuid NOT NULL REFERENCES fines,
  -- The payment that paid the due on time.
  payment_id uuid NOT NULL REFERENCES payments,
  -- The day the money arrived (Asia/Dhaka), on or before the due date.
  paid_on date NOT NULL,
  -- The cashier's reason when the payment was entered with an earlier date than the day of entry.
  reason text,
  cancelled_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fine_cancellations_fine_idx ON fine_cancellations (fine_id);
CREATE INDEX fine_cancellations_created_idx ON fine_cancellations (created_at DESC, id DESC);

CREATE TRIGGER no_mutation_fine_cancellations BEFORE UPDATE OR DELETE ON fine_cancellations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate_fine_cancellations BEFORE TRUNCATE ON fine_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Fine status (5.5): outstanding = amount - allocations, or 0 when waived or cancelled. `cancelled` is
-- added at the end so the view can be replaced in place.
CREATE OR REPLACE VIEW v_fine_status AS
SELECT
  f.id AS fine_id,
  f.due_id,
  f.member_id,
  f.kind,
  f.amount_paisa,
  f.waived_at,
  COALESCE(al.allocated_paisa, 0) AS allocated_paisa,
  CASE WHEN f.waived_at IS NOT NULL OR cx.cancelled THEN 0
       ELSE f.amount_paisa - COALESCE(al.allocated_paisa, 0) END AS outstanding_paisa,
  cx.cancelled
FROM fines f
LEFT JOIN (SELECT fine_id, SUM(amount_paisa) AS allocated_paisa
           FROM payment_allocations WHERE fine_id IS NOT NULL GROUP BY fine_id) al
  ON al.fine_id = f.id
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1
    FROM fine_cancellations c
    JOIN payments p ON p.id = c.payment_id
    WHERE c.fine_id = f.id
      AND p.status = 'confirmed'
      AND (SELECT COALESCE(SUM(pa.amount_paisa), 0) FROM payment_allocations pa WHERE pa.due_id = f.due_id)
          >= (SELECT d.amount_paisa FROM dues d WHERE d.id = f.due_id)
  ) AS cancelled
) cx;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT ON fine_cancellations TO barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON fine_cancellations TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
DROP VIEW IF EXISTS v_fine_status;
CREATE VIEW v_fine_status AS
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
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON v_fine_status TO barakah_readonly;
  END IF;
END
$grants$;
DROP TABLE IF EXISTS fine_cancellations;
