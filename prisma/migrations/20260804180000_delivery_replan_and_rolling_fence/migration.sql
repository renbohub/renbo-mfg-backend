ALTER TABLE "tbl_mps"
  ADD COLUMN "replan_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "replan_reason" TEXT,
  ADD COLUMN "source_changed_at" TIMESTAMP(3),
  ADD COLUMN "last_replanned_at" TIMESTAMP(3);

ALTER TABLE "tbl_monthly_production_plan"
  ADD COLUMN "replan_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "replan_reason" TEXT,
  ADD COLUMN "source_changed_at" TIMESTAMP(3),
  ADD COLUMN "last_replanned_at" TIMESTAMP(3),
  ADD COLUMN "planning_granularity" TEXT NOT NULL DEFAULT 'DAY',
  ADD COLUMN "rolling_lookback_weeks" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "freeze_fence_days" INTEGER NOT NULL DEFAULT 3;

CREATE TABLE "tbl_planning_change_impact" (
  "id" TEXT NOT NULL,
  "change_type" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_number" TEXT NOT NULL,
  "source_line_id" TEXT,
  "part_code" TEXT,
  "old_value" JSONB,
  "new_value" JSONB,
  "affected_mps_numbers" JSONB,
  "affected_plan_numbers" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING_REPLAN',
  "resolution_notes" TEXT,
  "changed_by" TEXT,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_by" TEXT,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_planning_change_impact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_planning_change_impact_source_type_source_number_idx" ON "tbl_planning_change_impact"("source_type", "source_number");
CREATE INDEX "tbl_planning_change_impact_status_idx" ON "tbl_planning_change_impact"("status");
CREATE INDEX "tbl_planning_change_impact_changed_at_idx" ON "tbl_planning_change_impact"("changed_at");
