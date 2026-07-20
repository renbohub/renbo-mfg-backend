ALTER TABLE "tbl_mps_detail"
  ADD COLUMN IF NOT EXISTS "buffer_reference_scope" TEXT NOT NULL DEFAULT 'PARENT_FG';

ALTER TABLE "tbl_mrp_requirement"
  ADD COLUMN IF NOT EXISTS "buffer_reference_scope" TEXT NOT NULL DEFAULT 'PARENT_FG';

ALTER TABLE "tbl_monthly_production_plan_detail"
  ADD COLUMN IF NOT EXISTS "mps_detail_id" TEXT,
  ADD COLUMN IF NOT EXISTS "forecast_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actual_sales_order_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_base_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "production_percent" DOUBLE PRECISION NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "effective_demand_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "tbl_monthly_production_plan_detail_mps_detail_id_idx"
  ON "tbl_monthly_production_plan_detail"("mps_detail_id");
