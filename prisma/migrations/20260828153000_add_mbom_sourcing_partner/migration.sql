ALTER TABLE "tbl_mbomdetail"
  ADD COLUMN "supplier_id" TEXT,
  ADD COLUMN "vendor_id" TEXT;

ALTER TABLE "tbl_mbomdetail"
  ADD CONSTRAINT "tbl_mbomdetail_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_mbomdetail"
  ADD CONSTRAINT "tbl_mbomdetail_vendor_id_fkey"
  FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tbl_mbomdetail_supplier_id_idx" ON "tbl_mbomdetail"("supplier_id");
CREATE INDEX "tbl_mbomdetail_vendor_id_idx" ON "tbl_mbomdetail"("vendor_id");
