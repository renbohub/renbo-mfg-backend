ALTER TABLE "tbl_manufacturing_order"
  DROP CONSTRAINT IF EXISTS "tbl_manufacturing_order_so_number_fkey";

DROP INDEX IF EXISTS "tbl_manufacturing_order_so_number_idx";

ALTER TABLE "tbl_manufacturing_order"
  DROP COLUMN IF EXISTS "so_number";
