-- Add UoM snapshot to Work Order operation quantity.
ALTER TABLE "tbl_work_order" ADD COLUMN "uom_code" TEXT;

CREATE INDEX "tbl_work_order_uom_code_idx" ON "tbl_work_order"("uom_code");

ALTER TABLE "tbl_work_order"
ADD CONSTRAINT "tbl_work_order_uom_code_fkey"
FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code")
ON DELETE SET NULL ON UPDATE CASCADE;
