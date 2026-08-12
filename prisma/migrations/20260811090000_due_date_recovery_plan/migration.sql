-- Additive PPIC due-date recovery governance. Existing planning, Forecast,
-- MPS/MRP, capacity and historical delivery targets are not rewritten.
CREATE TABLE IF NOT EXISTS "tbl_due_date_recovery_plan" (
  "id" TEXT NOT NULL,
  "delivery_target_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "is_current_plan" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "requested_delivery_date" TIMESTAMP(3) NOT NULL,
  "fg_required_date" TIMESTAMP(3),
  "earliest_feasible_fg_date" TIMESTAMP(3),
  "earliest_feasible_delivery" TIMESTAMP(3),
  "recovery_gap_days" INTEGER NOT NULL DEFAULT 0,
  "critical_constraint" TEXT,
  "feasibility_snapshot" JSONB NOT NULL,
  "checklist" JSONB NOT NULL,
  "notes" TEXT,
  "submitted_by" TEXT,
  "submitted_at" TIMESTAMP(3),
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "approval_reason" TEXT,
  "rejected_by" TEXT,
  "rejected_at" TIMESTAMP(3),
  "rejection_reason" TEXT,
  "created_by" TEXT,
  "updated_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_due_date_recovery_plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tbl_due_date_recovery_plan_delivery_target_id_revision_key"
  ON "tbl_due_date_recovery_plan"("delivery_target_id", "revision");
CREATE INDEX IF NOT EXISTS "tbl_due_date_recovery_plan_delivery_target_id_is_current_plan_idx"
  ON "tbl_due_date_recovery_plan"("delivery_target_id", "is_current_plan");
CREATE INDEX IF NOT EXISTS "tbl_due_date_recovery_plan_status_is_current_plan_idx"
  ON "tbl_due_date_recovery_plan"("status", "is_current_plan");
CREATE INDEX IF NOT EXISTS "tbl_due_date_recovery_plan_is_deleted_idx"
  ON "tbl_due_date_recovery_plan"("is_deleted");
