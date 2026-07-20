-- Hapus kolom mps_detail_id dan mrp_requirement_id dari tbl_manufacturing_order
-- Tambah kolom planned_order_number sebagai pengganti yang lebih tepat

DROP INDEX IF EXISTS "tbl_manufacturing_order_mps_detail_id_idx";
DROP INDEX IF EXISTS "tbl_manufacturing_order_mrp_requirement_id_idx";

ALTER TABLE "tbl_manufacturing_order" DROP COLUMN IF EXISTS "mps_detail_id";
ALTER TABLE "tbl_manufacturing_order" DROP COLUMN IF EXISTS "mrp_requirement_id";

ALTER TABLE "tbl_manufacturing_order" ADD COLUMN IF NOT EXISTS "planned_order_number" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_manufacturing_order_planned_order_number_idx" ON "tbl_manufacturing_order"("planned_order_number");
