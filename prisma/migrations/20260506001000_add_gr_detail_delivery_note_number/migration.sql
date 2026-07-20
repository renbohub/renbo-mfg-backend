ALTER TABLE "tbl_goods_receipt_detail"
ADD COLUMN "delivery_note_number" TEXT;

CREATE INDEX "tbl_goods_receipt_detail_delivery_note_number_idx"
ON "tbl_goods_receipt_detail"("delivery_note_number");
