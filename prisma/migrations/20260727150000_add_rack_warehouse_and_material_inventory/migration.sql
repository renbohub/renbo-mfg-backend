-- Rack ownership is nullable so legacy racks remain valid until assigned.
ALTER TABLE "tbl_rack"
ADD COLUMN IF NOT EXISTS "warehouse_code" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_rack_warehouse_code_idx"
ON "tbl_rack"("warehouse_code");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_rack_warehouse_code_fkey'
  ) THEN
    ALTER TABLE "tbl_rack"
    ADD CONSTRAINT "tbl_rack_warehouse_code_fkey"
    FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Material identity is additive. Existing part/product based stock remains valid.
ALTER TABLE "tbl_lot_master"
ADD COLUMN IF NOT EXISTS "material_id" TEXT,
ADD COLUMN IF NOT EXISTS "material_code" TEXT,
ADD COLUMN IF NOT EXISTS "material_name" TEXT;

ALTER TABLE "tbl_stock_balance"
ADD COLUMN IF NOT EXISTS "material_id" TEXT,
ADD COLUMN IF NOT EXISTS "material_code" TEXT,
ADD COLUMN IF NOT EXISTS "material_name" TEXT,
ADD COLUMN IF NOT EXISTS "material_type" TEXT;

ALTER TABLE "tbl_stock_movement"
ADD COLUMN IF NOT EXISTS "material_id" TEXT,
ADD COLUMN IF NOT EXISTS "material_code" TEXT,
ADD COLUMN IF NOT EXISTS "material_name" TEXT,
ADD COLUMN IF NOT EXISTS "material_type" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_lot_master_material_id_idx" ON "tbl_lot_master"("material_id");
CREATE INDEX IF NOT EXISTS "tbl_lot_master_material_code_idx" ON "tbl_lot_master"("material_code");
CREATE INDEX IF NOT EXISTS "tbl_stock_balance_material_id_idx" ON "tbl_stock_balance"("material_id");
CREATE INDEX IF NOT EXISTS "tbl_stock_balance_material_code_idx" ON "tbl_stock_balance"("material_code");
CREATE INDEX IF NOT EXISTS "tbl_stock_movement_material_id_idx" ON "tbl_stock_movement"("material_id");
CREATE INDEX IF NOT EXISTS "tbl_stock_movement_material_code_idx" ON "tbl_stock_movement"("material_code");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_lot_master_material_id_fkey'
  ) THEN
    ALTER TABLE "tbl_lot_master"
    ADD CONSTRAINT "tbl_lot_master_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "tbl_material"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_stock_balance_material_id_fkey'
  ) THEN
    ALTER TABLE "tbl_stock_balance"
    ADD CONSTRAINT "tbl_stock_balance_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "tbl_material"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_stock_movement_material_id_fkey'
  ) THEN
    ALTER TABLE "tbl_stock_movement"
    ADD CONSTRAINT "tbl_stock_movement_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "tbl_material"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
