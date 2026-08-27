ALTER TABLE "tbl_monthly_production_plan_detail"
  ADD COLUMN "mrp_requirement_id" TEXT,
  ADD COLUMN "mrp_requirement_ids" JSONB,
  ADD COLUMN "mrp_root_requirement_id" TEXT;

CREATE INDEX "tbl_monthly_production_plan_detail_mrp_requirement_id_idx"
  ON "tbl_monthly_production_plan_detail"("mrp_requirement_id");

CREATE INDEX "tbl_monthly_production_plan_detail_mrp_root_requirement_id_idx"
  ON "tbl_monthly_production_plan_detail"("mrp_root_requirement_id");
