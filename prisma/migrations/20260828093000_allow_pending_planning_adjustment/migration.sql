ALTER TABLE "tbl_planning_adjustment"
  DROP CONSTRAINT IF EXISTS "tbl_planning_adjustment_status_check";

ALTER TABLE "tbl_planning_adjustment"
  ADD CONSTRAINT "tbl_planning_adjustment_status_check"
  CHECK (UPPER("status") IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED', 'SUPERSEDED'));
