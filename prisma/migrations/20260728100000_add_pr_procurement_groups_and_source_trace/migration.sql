-- Purchasing grouping and normalized MRP/demand traceability.
-- Additive only: legacy PR category inference and JSON allocations remain valid.

ALTER TABLE "tbl_purchase_requisition"
  ADD COLUMN IF NOT EXISTS "procurement_group" TEXT;

ALTER TABLE "tbl_purchase_requisition_detail"
  ADD COLUMN IF NOT EXISTS "procurement_category" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_procurement_group_idx"
  ON "tbl_purchase_requisition"("procurement_group");

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_detail_procurement_category_idx"
  ON "tbl_purchase_requisition_detail"("procurement_category");

CREATE TABLE IF NOT EXISTS "tbl_purchase_requisition_source" (
  "id" TEXT NOT NULL,
  "pr_detail_id" TEXT NOT NULL,
  "planned_order_number" TEXT,
  "mrp_run_number" TEXT,
  "mps_number" TEXT,
  "mps_detail_id" TEXT,
  "forecast_number" TEXT,
  "forecast_detail_id" TEXT,
  "so_number" TEXT,
  "source_type" TEXT,
  "source_number" TEXT,
  "demand_month" TIMESTAMP(3),
  "required_date" TIMESTAMP(3),
  "part_code" TEXT,
  "fg_part_code" TEXT,
  "qty" DOUBLE PRECISION NOT NULL,
  "uom_code" TEXT,
  "metadata" JSONB,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_purchase_requisition_source_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_purchase_requisition_source_pr_detail_id_fkey"
    FOREIGN KEY ("pr_detail_id")
    REFERENCES "tbl_purchase_requisition_detail"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_pr_detail_id_idx"
  ON "tbl_purchase_requisition_source"("pr_detail_id");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_planned_order_number_idx"
  ON "tbl_purchase_requisition_source"("planned_order_number");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_mrp_run_number_idx"
  ON "tbl_purchase_requisition_source"("mrp_run_number");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_mps_number_idx"
  ON "tbl_purchase_requisition_source"("mps_number");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_forecast_number_idx"
  ON "tbl_purchase_requisition_source"("forecast_number");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_so_number_idx"
  ON "tbl_purchase_requisition_source"("so_number");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_demand_month_idx"
  ON "tbl_purchase_requisition_source"("demand_month");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_part_code_idx"
  ON "tbl_purchase_requisition_source"("part_code");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_fg_part_code_idx"
  ON "tbl_purchase_requisition_source"("fg_part_code");
CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_is_deleted_idx"
  ON "tbl_purchase_requisition_source"("is_deleted");

-- Persist a safe initial classification for existing records without deleting
-- or rewriting any legacy fields.
UPDATE "tbl_purchase_requisition_detail"
SET "procurement_category" = CASE
  WHEN "material_code" IS NOT NULL THEN 'MATERIAL'
  WHEN "part_code" IS NULL THEN 'NON_PRODUCTION'
  ELSE "procurement_category"
END
WHERE "procurement_category" IS NULL;
