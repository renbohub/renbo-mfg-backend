ALTER TABLE "tbl_work_order" ADD COLUMN "mbom_detail_id" TEXT;

CREATE INDEX "tbl_work_order_mbom_detail_id_idx" ON "tbl_work_order"("mbom_detail_id");

ALTER TABLE "tbl_work_order"
ADD CONSTRAINT "tbl_work_order_mbom_detail_id_fkey"
FOREIGN KEY ("mbom_detail_id") REFERENCES "tbl_mbomdetail"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
