ALTER TABLE "tbl_purchase_order_comments" ADD COLUMN "parent_id" TEXT;

CREATE INDEX "tbl_purchase_order_comments_parent_id_idx" ON "tbl_purchase_order_comments"("parent_id");

ALTER TABLE "tbl_purchase_order_comments"
  ADD CONSTRAINT "tbl_purchase_order_comments_parent_id_fkey"
  FOREIGN KEY ("parent_id")
  REFERENCES "tbl_purchase_order_comments"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
