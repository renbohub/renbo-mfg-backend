ALTER TABLE "tbl_purchase_requisition"
  ADD COLUMN "header_material_id" TEXT,
  ADD COLUMN "header_material_code" TEXT,
  ADD COLUMN "header_material_name" TEXT,
  ADD COLUMN "demand_bucket" TEXT,
  ADD COLUMN "warehouse_code" TEXT;

ALTER TABLE "tbl_purchase_requisition_detail"
  ADD COLUMN "recommended_purchase_forms" JSONB;

CREATE TABLE "tbl_purchase_requisition_sourcing_allocation" (
  "id" TEXT NOT NULL,
  "pr_detail_id" TEXT NOT NULL,
  "supplier_code" TEXT,
  "vendor_code" TEXT,
  "demand_covered_qty" DOUBLE PRECISION NOT NULL,
  "demand_uom_code" TEXT,
  "purchase_package_qty" DOUBLE PRECISION,
  "purchase_package_uom_code" TEXT,
  "conversion_factor" DOUBLE PRECISION,
  "conversion_uom_code" TEXT,
  "converted_purchase_qty" DOUBLE PRECISION,
  "delivery_date" TIMESTAMP(3),
  "currency_code" TEXT,
  "unit_price" DOUBLE PRECISION,
  "total_amount" DOUBLE PRECISION,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "po_number" TEXT,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_purchase_requisition_sourcing_allocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_purchase_requisition_sourcing_allocation_pr_detail_id_fkey"
    FOREIGN KEY ("pr_detail_id") REFERENCES "tbl_purchase_requisition_detail"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tbl_purchase_requisition_header_material_id_idx"
  ON "tbl_purchase_requisition"("header_material_id");
CREATE INDEX "tbl_purchase_requisition_header_material_code_idx"
  ON "tbl_purchase_requisition"("header_material_code");
CREATE INDEX "tbl_purchase_requisition_demand_bucket_idx"
  ON "tbl_purchase_requisition"("demand_bucket");
CREATE INDEX "tbl_purchase_requisition_warehouse_code_idx"
  ON "tbl_purchase_requisition"("warehouse_code");
CREATE INDEX "tbl_pr_sourcing_allocation_pr_detail_id_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("pr_detail_id");
CREATE INDEX "tbl_pr_sourcing_allocation_supplier_code_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("supplier_code");
CREATE INDEX "tbl_pr_sourcing_allocation_vendor_code_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("vendor_code");
CREATE INDEX "tbl_pr_sourcing_allocation_delivery_date_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("delivery_date");
CREATE INDEX "tbl_pr_sourcing_allocation_status_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("status");
CREATE INDEX "tbl_pr_sourcing_allocation_po_number_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("po_number");
CREATE INDEX "tbl_pr_sourcing_allocation_is_deleted_idx"
  ON "tbl_purchase_requisition_sourcing_allocation"("is_deleted");

UPDATE "tbl_purchase_requisition" pr
SET
  "header_material_id" = detail."material_id",
  "header_material_code" = detail."material_code",
  "header_material_name" = detail."material_name",
  "demand_bucket" = TO_CHAR(pr."required_date", 'YYYY-MM')
FROM (
  SELECT DISTINCT ON ("pr_number")
    "pr_number", "material_id", "material_code", "material_name"
  FROM "tbl_purchase_requisition_detail"
  WHERE "is_deleted" = false AND "material_code" IS NOT NULL
  ORDER BY "pr_number", "line_number"
) detail
WHERE pr."pr_number" = detail."pr_number"
  AND pr."procurement_group" = 'MATERIAL';
