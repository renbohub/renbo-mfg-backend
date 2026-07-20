-- Sync migration history with db push changes
-- Semua perubahan ini sudah ada di DB via prisma db push, jadi pakai IF NOT EXISTS

-- ============================================
-- tbl_lot_master: tambah description dan product_id
-- ============================================
ALTER TABLE "tbl_lot_master" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "tbl_lot_master" ADD COLUMN IF NOT EXISTS "product_id" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_lot_master_description_idx" ON "tbl_lot_master"("description");
CREATE INDEX IF NOT EXISTS "tbl_lot_master_product_id_idx" ON "tbl_lot_master"("product_id");

DO $$ BEGIN
  ALTER TABLE "tbl_lot_master" ADD CONSTRAINT "tbl_lot_master_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- tbl_stock_reservation: tambah rack_code dan lot_number
-- ============================================
ALTER TABLE "tbl_stock_reservation" ADD COLUMN IF NOT EXISTS "rack_code" TEXT;
ALTER TABLE "tbl_stock_reservation" ADD COLUMN IF NOT EXISTS "lot_number" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_stock_reservation_rack_code_idx" ON "tbl_stock_reservation"("rack_code");
CREATE INDEX IF NOT EXISTS "tbl_stock_reservation_lot_number_idx" ON "tbl_stock_reservation"("lot_number");

DO $$ BEGIN
  ALTER TABLE "tbl_stock_reservation" ADD CONSTRAINT "tbl_stock_reservation_rack_code_fkey"
    FOREIGN KEY ("rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- tbl_goods_receipt_detail: restore index lot_number yang hilang setelah db push
-- ============================================
CREATE INDEX IF NOT EXISTS "tbl_goods_receipt_detail_lot_number_idx" ON "tbl_goods_receipt_detail"("lot_number");
