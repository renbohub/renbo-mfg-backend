ALTER TABLE "tbl_mbomdetail"
ADD COLUMN "parent_detail_id" TEXT;

CREATE INDEX "tbl_mbomdetail_parent_detail_id_idx"
ON "tbl_mbomdetail"("parent_detail_id");

ALTER TABLE "tbl_mbomdetail"
ADD CONSTRAINT "tbl_mbomdetail_parent_detail_id_fkey"
FOREIGN KEY ("parent_detail_id")
REFERENCES "tbl_mbomdetail"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
