-- Add UoM snapshot to Manufacturing Order.
ALTER TABLE "tbl_manufacturing_order" ADD COLUMN "uom_code" TEXT;

CREATE INDEX "tbl_manufacturing_order_uom_code_idx" ON "tbl_manufacturing_order"("uom_code");

ALTER TABLE "tbl_manufacturing_order"
ADD CONSTRAINT "tbl_manufacturing_order_uom_code_fkey"
FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code")
ON DELETE SET NULL ON UPDATE CASCADE;
