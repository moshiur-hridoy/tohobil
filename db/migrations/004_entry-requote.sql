-- Up Migration
-- 004: An entry quote that lapsed (7 days, Doc.md 5.9) can be replaced by a fresh one at today's price.
-- Dues are immutable, so the old entry due is not edited: an append-only `due_cancellations` row closes
-- it at what was already paid on it, and a new entry due carries the rest of the new price. The view
-- `v_due_status` treats a cancelled due as owing nothing more (and hides one that never got a payment).
-- A member may therefore hold more than one entry due in a month, so the one-due-per-month rule becomes
-- a partial unique index that leaves `entry` out. Safe on a database that already ran 001 to 003.

CREATE TABLE due_cancellations (
  due_id uuid PRIMARY KEY REFERENCES dues,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  cancelled_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER no_mutation_due_cancellations BEFORE UPDATE OR DELETE ON due_cancellations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE dues DROP CONSTRAINT dues_member_id_period_kind_key;
CREATE UNIQUE INDEX dues_one_per_period ON dues (member_id, period, kind) WHERE kind <> 'entry';

CREATE OR REPLACE VIEW v_due_status AS
WITH alloc AS (
  SELECT
    pa.due_id,
    SUM(pa.amount_paisa) AS allocated_paisa,
    MAX((p.paid_at AT TIME ZONE 'Asia/Dhaka')::date) FILTER (WHERE pa.amount_paisa > 0 AND p.status = 'confirmed') AS last_paid_on
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  WHERE pa.due_id IS NOT NULL
  GROUP BY pa.due_id
),
base AS (
  SELECT
    d.*,
    COALESCE(al.allocated_paisa, 0) AS allocated,
    al.last_paid_on,
    -- A cancelled due is closed at what was paid on it.
    CASE WHEN c.due_id IS NOT NULL THEN COALESCE(al.allocated_paisa, 0)::bigint ELSE d.amount_paisa END AS owed
  FROM dues d
  LEFT JOIN alloc al ON al.due_id = d.id
  LEFT JOIN due_cancellations c ON c.due_id = d.id
  WHERE c.due_id IS NULL OR COALESCE(al.allocated_paisa, 0) > 0
)
SELECT
  b.id AS due_id,
  b.member_id,
  b.period,
  b.kind,
  b.shares_snapshot,
  b.owed AS amount_paisa,
  b.due_date,
  b.allocated AS allocated_paisa,
  b.owed - b.allocated AS outstanding_paisa,
  CASE
    WHEN b.owed - b.allocated <= 0
      THEN CASE WHEN b.last_paid_on > b.due_date THEN 'paid_late' ELSE 'paid' END
    WHEN today_dhaka() > b.due_date THEN 'overdue'
    WHEN b.allocated > 0 THEN 'partial'
    ELSE 'unpaid'
  END AS status
FROM base b;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_app') THEN
    GRANT SELECT, INSERT ON due_cancellations TO barakah_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'barakah_readonly') THEN
    GRANT SELECT ON due_cancellations TO barakah_readonly;
  END IF;
END
$grants$;

-- Down Migration
CREATE OR REPLACE VIEW v_due_status AS
WITH alloc AS (
  SELECT
    pa.due_id,
    SUM(pa.amount_paisa) AS allocated_paisa,
    MAX((p.paid_at AT TIME ZONE 'Asia/Dhaka')::date) FILTER (WHERE pa.amount_paisa > 0 AND p.status = 'confirmed') AS last_paid_on
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  WHERE pa.due_id IS NOT NULL
  GROUP BY pa.due_id
)
SELECT
  d.id AS due_id,
  d.member_id,
  d.period,
  d.kind,
  d.shares_snapshot,
  d.amount_paisa,
  d.due_date,
  COALESCE(al.allocated_paisa, 0) AS allocated_paisa,
  d.amount_paisa - COALESCE(al.allocated_paisa, 0) AS outstanding_paisa,
  CASE
    WHEN d.amount_paisa - COALESCE(al.allocated_paisa, 0) <= 0
      THEN CASE WHEN al.last_paid_on > d.due_date THEN 'paid_late' ELSE 'paid' END
    WHEN today_dhaka() > d.due_date THEN 'overdue'
    WHEN COALESCE(al.allocated_paisa, 0) > 0 THEN 'partial'
    ELSE 'unpaid'
  END AS status
FROM dues d
LEFT JOIN alloc al ON al.due_id = d.id;
DROP INDEX IF EXISTS dues_one_per_period;
ALTER TABLE dues ADD CONSTRAINT dues_member_id_period_kind_key UNIQUE (member_id, period, kind);
DROP TABLE IF EXISTS due_cancellations;
