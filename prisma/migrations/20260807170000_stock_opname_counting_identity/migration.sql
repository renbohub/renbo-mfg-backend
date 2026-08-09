ALTER TABLE "tbl_sto_details"
  ADD COLUMN "material_id" TEXT,
  ADD COLUMN "material_code" TEXT,
  ADD COLUMN "material_name" TEXT,
  ADD COLUMN "material_type" TEXT;

UPDATE "tbl_sto_details" AS detail
SET
  "material_id" = balance."material_id",
  "material_code" = balance."material_code",
  "material_name" = balance."material_name",
  "material_type" = balance."material_type"
FROM "tbl_stock_balance" AS balance
WHERE detail."stock_balance_id" = balance."id";

CREATE INDEX "tbl_sto_details_material_id_idx" ON "tbl_sto_details"("material_id");
CREATE INDEX "tbl_sto_details_material_code_idx" ON "tbl_sto_details"("material_code");
CREATE INDEX "tbl_sto_details_material_type_idx" ON "tbl_sto_details"("material_type");
