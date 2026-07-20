-- Drop Work Center references in favor of master data Process routing.
ALTER TABLE "tbl_machine" DROP CONSTRAINT IF EXISTS "tbl_machine_work_center_id_fkey";
ALTER TABLE "tbl_ebomprocess" DROP CONSTRAINT IF EXISTS "tbl_ebomprocess_work_center_id_fkey";
ALTER TABLE "tbl_mbomprocess" DROP CONSTRAINT IF EXISTS "tbl_mbomprocess_work_center_id_fkey";
ALTER TABLE "tbl_work_order" DROP CONSTRAINT IF EXISTS "tbl_work_order_work_center_id_fkey";

DROP INDEX IF EXISTS "tbl_machine_work_center_id_idx";
DROP INDEX IF EXISTS "tbl_ebomprocess_work_center_id_idx";
DROP INDEX IF EXISTS "tbl_mbomprocess_work_center_id_idx";
DROP INDEX IF EXISTS "tbl_work_order_work_center_id_idx";

ALTER TABLE "tbl_machine" DROP COLUMN IF EXISTS "work_center_id";
ALTER TABLE "tbl_ebomprocess" DROP COLUMN IF EXISTS "work_center_id";
ALTER TABLE "tbl_mbomprocess" DROP COLUMN IF EXISTS "work_center_id";
ALTER TABLE "tbl_work_order" DROP COLUMN IF EXISTS "work_center_id";

DROP TABLE IF EXISTS "tbl_work_center";
