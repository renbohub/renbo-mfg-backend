-- Preserve revision history, but allow only one active/current MRP revision for
-- each logical plan (a canonical monthly MPS has plan number MRP-MPS-YYYYMM).
WITH ranked_current_plans AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY plan_number
      ORDER BY run_date DESC, created_at DESC, id DESC
    ) AS revision_rank
  FROM tbl_mrp_run
  WHERE plan_number IS NOT NULL
    AND is_current_plan = TRUE
    AND is_deleted = FALSE
)
UPDATE tbl_mrp_run AS run
SET
  is_current_plan = FALSE,
  updated_at = CURRENT_TIMESTAMP
FROM ranked_current_plans AS ranked
WHERE run.id = ranked.id
  AND ranked.revision_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS tbl_mrp_run_one_current_plan
  ON tbl_mrp_run (plan_number)
  WHERE plan_number IS NOT NULL
    AND is_current_plan = TRUE
    AND is_deleted = FALSE;
