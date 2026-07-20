ALTER TABLE "public"."tbl_vendor_process_order"
ADD COLUMN IF NOT EXISTS "is_rework_order" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rework_source_type" TEXT,
ADD COLUMN IF NOT EXISTS "rework_reference_type" TEXT,
ADD COLUMN IF NOT EXISTS "rework_reference_number" TEXT,
ADD COLUMN IF NOT EXISTS "rework_reference_label" TEXT;

ALTER TABLE "public"."tbl_work_order"
ADD COLUMN IF NOT EXISTS "output_part_id" TEXT,
ADD COLUMN IF NOT EXISTS "output_part_code" TEXT,
ADD COLUMN IF NOT EXISTS "output_part_number" TEXT,
ADD COLUMN IF NOT EXISTS "output_part_name" TEXT,
ADD COLUMN IF NOT EXISTS "is_rework_order" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rework_source_type" TEXT,
ADD COLUMN IF NOT EXISTS "rework_reference_type" TEXT,
ADD COLUMN IF NOT EXISTS "rework_reference_number" TEXT,
ADD COLUMN IF NOT EXISTS "rework_reference_label" TEXT;

ALTER TABLE "public"."tbl_wip_entry"
ADD COLUMN IF NOT EXISTS "part_code" TEXT,
ADD COLUMN IF NOT EXISTS "part_number" TEXT,
ADD COLUMN IF NOT EXISTS "part_name" TEXT,
ADD COLUMN IF NOT EXISTS "uom_code" TEXT,
ADD COLUMN IF NOT EXISTS "warehouse_code" TEXT,
ADD COLUMN IF NOT EXISTS "rack_code" TEXT,
ADD COLUMN IF NOT EXISTS "lot_number" TEXT,
ADD COLUMN IF NOT EXISTS "stock_type" TEXT;

ALTER TABLE "public"."tbl_stock_movement"
ADD COLUMN IF NOT EXISTS "quality_bucket" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_vendor_process_order_is_rework_order_idx"
  ON "public"."tbl_vendor_process_order"("is_rework_order");
CREATE INDEX IF NOT EXISTS "tbl_vendor_process_order_rework_source_type_idx"
  ON "public"."tbl_vendor_process_order"("rework_source_type");
CREATE INDEX IF NOT EXISTS "tbl_vendor_process_order_rework_reference_number_idx"
  ON "public"."tbl_vendor_process_order"("rework_reference_number");

CREATE INDEX IF NOT EXISTS "tbl_work_order_output_part_code_idx"
  ON "public"."tbl_work_order"("output_part_code");
CREATE INDEX IF NOT EXISTS "tbl_work_order_is_rework_order_idx"
  ON "public"."tbl_work_order"("is_rework_order");
CREATE INDEX IF NOT EXISTS "tbl_work_order_rework_source_type_idx"
  ON "public"."tbl_work_order"("rework_source_type");
CREATE INDEX IF NOT EXISTS "tbl_work_order_rework_reference_number_idx"
  ON "public"."tbl_work_order"("rework_reference_number");

CREATE INDEX IF NOT EXISTS "tbl_wip_entry_part_code_idx"
  ON "public"."tbl_wip_entry"("part_code");
CREATE INDEX IF NOT EXISTS "tbl_wip_entry_part_number_idx"
  ON "public"."tbl_wip_entry"("part_number");

CREATE INDEX IF NOT EXISTS "tbl_stock_movement_quality_bucket_idx"
  ON "public"."tbl_stock_movement"("quality_bucket");
