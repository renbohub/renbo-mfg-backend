ALTER TABLE "tbl_vendor_process_order"
  ADD COLUMN "vendor_price_list_id" TEXT,
  ADD COLUMN "vendor_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "vendor_currency" TEXT,
  ADD COLUMN "planned_vendor_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "actual_vendor_cost" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX "tbl_vendor_process_order_vendor_price_list_id_idx"
  ON "tbl_vendor_process_order"("vendor_price_list_id");

ALTER TABLE "tbl_vendor_process_order"
  ADD CONSTRAINT "tbl_vendor_process_order_vendor_price_list_id_fkey"
  FOREIGN KEY ("vendor_price_list_id")
  REFERENCES "tbl_vendor_pricelist"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
