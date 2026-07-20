-- Add quotation reference and attachment JSON files to PO header.
ALTER TABLE "tbl_purchase_order"
ADD COLUMN "quotation_number" TEXT,
ADD COLUMN "quotation_files" JSONB;

CREATE INDEX "tbl_purchase_order_quotation_number_idx"
ON "tbl_purchase_order"("quotation_number");
