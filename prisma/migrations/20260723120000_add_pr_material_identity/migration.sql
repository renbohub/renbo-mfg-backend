-- Preserve Material Master identity on MRP-generated PR/PO lines without
-- removing legacy part identity fields.
ALTER TABLE "tbl_purchase_requisition"
  ADD COLUMN IF NOT EXISTS "source_type" TEXT NOT NULL DEFAULT 'MANUAL';

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_source_type_idx"
  ON "tbl_purchase_requisition"("source_type");

ALTER TABLE "tbl_purchase_requisition_detail"
  ADD COLUMN IF NOT EXISTS "material_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_code" TEXT,
  ADD COLUMN IF NOT EXISTS "material_name" TEXT,
  ADD COLUMN IF NOT EXISTS "material_type" TEXT,
  ADD COLUMN IF NOT EXISTS "source_planned_order_numbers" JSONB;

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_detail_material_code_idx"
  ON "tbl_purchase_requisition_detail"("material_code");

ALTER TABLE "tbl_purchase_order_detail"
  ADD COLUMN IF NOT EXISTS "material_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_code" TEXT,
  ADD COLUMN IF NOT EXISTS "material_name" TEXT,
  ADD COLUMN IF NOT EXISTS "material_type" TEXT;
