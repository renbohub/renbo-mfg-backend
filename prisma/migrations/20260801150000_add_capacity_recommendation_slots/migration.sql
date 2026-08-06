ALTER TABLE "tbl_monthly_production_plan"
  ADD COLUMN IF NOT EXISTS "recommendation_generated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recommendation_version" TEXT,
  ADD COLUMN IF NOT EXISTS "recommendation_summary" JSONB;

ALTER TABLE "tbl_production_plan_allocation"
  ADD COLUMN IF NOT EXISTS "planned_start_time" TEXT,
  ADD COLUMN IF NOT EXISTS "planned_end_time" TEXT,
  ADD COLUMN IF NOT EXISTS "allocation_source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "recommendation_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "capacity_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_phase_id" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_phase_number" INTEGER,
  ADD COLUMN IF NOT EXISTS "transfer_batch_number" INTEGER,
  ADD COLUMN IF NOT EXISTS "predecessor_allocation_ids" JSONB;

CREATE INDEX IF NOT EXISTS "tbl_production_plan_allocation_allocation_source_idx"
  ON "tbl_production_plan_allocation"("allocation_source");
CREATE INDEX IF NOT EXISTS "tbl_production_plan_allocation_delivery_phase_id_idx"
  ON "tbl_production_plan_allocation"("delivery_phase_id");
