-- Move rack_code dari tbl_goods_receipt header ke tbl_goods_receipt_detail (per-item putaway)
-- warehouse_code tetap di header (satu GR = satu gudang)

-- 1. Drop FK dan index rack_code dari header
ALTER TABLE "tbl_goods_receipt" DROP CONSTRAINT IF EXISTS "tbl_goods_receipt_rack_code_fkey";
DROP INDEX IF EXISTS "tbl_goods_receipt_rack_code_idx";

-- 2. Hapus kolom rack_code dari header
ALTER TABLE "tbl_goods_receipt" DROP COLUMN IF EXISTS "rack_code";

-- 3. Tambah kolom rack_code ke detail (opsional, per item)
ALTER TABLE "tbl_goods_receipt_detail" ADD COLUMN "rack_code" TEXT;

-- 4. Buat index di detail
CREATE INDEX "tbl_goods_receipt_detail_rack_code_idx" ON "tbl_goods_receipt_detail"("rack_code");

-- 5. Tambah FK di detail
ALTER TABLE "tbl_goods_receipt_detail" ADD CONSTRAINT "tbl_goods_receipt_detail_rack_code_fkey"
  FOREIGN KEY ("rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;
