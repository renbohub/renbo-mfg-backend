ALTER TABLE "tbl_manufacturing_order"
  ADD COLUMN "input_source_type" TEXT NOT NULL DEFAULT 'MBOM',
  ADD COLUMN "source_stock_balance_id" TEXT,
  ADD COLUMN "source_warehouse_code" TEXT,
  ADD COLUMN "source_rack_code" TEXT,
  ADD COLUMN "source_lot_number" TEXT,
  ADD COLUMN "source_part_code" TEXT,
  ADD COLUMN "source_part_number" TEXT,
  ADD COLUMN "source_part_name" TEXT,
  ADD COLUMN "source_stock_type" TEXT,
  ADD COLUMN "source_qty_planned" DOUBLE PRECISION;

CREATE INDEX "tbl_manufacturing_order_input_source_type_idx"
  ON "tbl_manufacturing_order"("input_source_type");

CREATE INDEX "tbl_manufacturing_order_source_stock_balance_id_idx"
  ON "tbl_manufacturing_order"("source_stock_balance_id");

ALTER TABLE "tbl_manufacturing_order"
  ADD CONSTRAINT "tbl_manufacturing_order_source_stock_balance_id_fkey"
  FOREIGN KEY ("source_stock_balance_id") REFERENCES "tbl_stock_balance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
