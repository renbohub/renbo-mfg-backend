-- ============================================
-- LOT TRACKING MIGRATION
-- ============================================

-- 1. Create tbl_lot_master
CREATE TABLE "tbl_lot_master" (
    "id" TEXT NOT NULL,
    "lot_number" TEXT NOT NULL,
    "part_code" TEXT,
    "supplier_batch" TEXT,
    "manufacturing_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tbl_lot_master_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_lot_master_lot_number_key" ON "tbl_lot_master"("lot_number");
CREATE INDEX "tbl_lot_master_lot_number_idx" ON "tbl_lot_master"("lot_number");
CREATE INDEX "tbl_lot_master_part_code_idx" ON "tbl_lot_master"("part_code");
CREATE INDEX "tbl_lot_master_expiry_date_idx" ON "tbl_lot_master"("expiry_date");
CREATE INDEX "tbl_lot_master_is_deleted_idx" ON "tbl_lot_master"("is_deleted");

-- 2. Add lot_number to tbl_goods_receipt_detail
ALTER TABLE "tbl_goods_receipt_detail" ADD COLUMN "lot_number" TEXT;
CREATE INDEX "tbl_goods_receipt_detail_lot_number_idx" ON "tbl_goods_receipt_detail"("lot_number");

-- 3. Add lot_number to tbl_stock_balance
ALTER TABLE "tbl_stock_balance" ADD COLUMN "lot_number" TEXT;

-- Drop existing unique constraint (includes warehouseCode + rackCode + item identity, no lot)
DROP INDEX IF EXISTS "tbl_stock_balance_warehouse_code_rack_code_part_code_produc_key";

-- Create new unique constraint including lot_number (NULLS NOT DISTINCT = NULL equals NULL)
CREATE UNIQUE INDEX "tbl_stock_balance_wh_rack_lot_identity_key"
  ON "tbl_stock_balance"("warehouse_code", "rack_code", "lot_number", "part_code", "product_id", "description")
  NULLS NOT DISTINCT;

CREATE INDEX "tbl_stock_balance_lot_number_idx" ON "tbl_stock_balance"("lot_number");

-- 4. Add lot_number to tbl_stock_movement
ALTER TABLE "tbl_stock_movement" ADD COLUMN "lot_number" TEXT;
CREATE INDEX "tbl_stock_movement_lot_number_idx" ON "tbl_stock_movement"("lot_number");
