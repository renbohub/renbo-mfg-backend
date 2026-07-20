ALTER TABLE "tbl_goods_receipt_detail"
ADD COLUMN "supplier_lot_number" TEXT;

CREATE INDEX "tbl_goods_receipt_detail_supplier_lot_number_idx"
ON "tbl_goods_receipt_detail"("supplier_lot_number");
