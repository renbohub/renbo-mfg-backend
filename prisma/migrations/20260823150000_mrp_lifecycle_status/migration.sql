ALTER TABLE "tbl_mrp_run"
  ALTER COLUMN "scenario_status" SET DEFAULT 'DRAFT';

-- Legacy working revisions (including R023) used SIMULATION while the
-- approval contract uses SIMULATED. Normalize the stored vocabulary before
-- constraining future writes.
UPDATE "tbl_mrp_run"
SET "scenario_status" = 'SIMULATED'
WHERE UPPER(TRIM("scenario_status")) = 'SIMULATION';

ALTER TABLE "tbl_mrp_run"
  DROP CONSTRAINT IF EXISTS "tbl_mrp_run_scenario_status_check";

ALTER TABLE "tbl_mrp_run"
  ADD CONSTRAINT "tbl_mrp_run_scenario_status_check"
  CHECK (UPPER("scenario_status") IN ('DRAFT', 'SIMULATED', 'APPROVED', 'SUPERSEDED'));
