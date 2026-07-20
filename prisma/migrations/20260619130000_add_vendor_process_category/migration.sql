ALTER TABLE "tbl_vendor_process"
ADD COLUMN "category" TEXT;

CREATE INDEX "tbl_vendor_process_category_idx" ON "tbl_vendor_process"("category");