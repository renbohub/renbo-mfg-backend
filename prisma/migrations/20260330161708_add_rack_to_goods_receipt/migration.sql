-- Add rack_code to tbl_goods_receipt
ALTER TABLE "tbl_goods_receipt" ADD COLUMN "rack_code" TEXT;

-- Index
CREATE INDEX "tbl_goods_receipt_rack_code_idx" ON "tbl_goods_receipt"("rack_code");

-- Foreign key to tbl_rack
ALTER TABLE "tbl_goods_receipt" ADD CONSTRAINT "tbl_goods_receipt_rack_code_fkey"
  FOREIGN KEY ("rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;
