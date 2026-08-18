ALTER TABLE "tbl_stock_reservation"
  ADD COLUMN "material_id" TEXT,
  ADD COLUMN "material_code" TEXT,
  ADD COLUMN "material_name" TEXT,
  ADD COLUMN "material_type" TEXT,
  ADD COLUMN "target_part_code" TEXT,
  ADD COLUMN "target_part_number" TEXT,
  ADD COLUMN "target_part_name" TEXT;

CREATE INDEX "tbl_stock_reservation_material_id_idx"
  ON "tbl_stock_reservation"("material_id");

CREATE INDEX "tbl_stock_reservation_material_code_idx"
  ON "tbl_stock_reservation"("material_code");

CREATE INDEX "tbl_stock_reservation_target_part_code_idx"
  ON "tbl_stock_reservation"("target_part_code");

CREATE INDEX "tbl_stock_reservation_target_part_number_idx"
  ON "tbl_stock_reservation"("target_part_number");
