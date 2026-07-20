ALTER TABLE "tbl_goods_receipt"
ADD COLUMN "delivery_note_number" TEXT;

CREATE INDEX "tbl_goods_receipt_delivery_note_number_idx"
ON "tbl_goods_receipt"("delivery_note_number");
