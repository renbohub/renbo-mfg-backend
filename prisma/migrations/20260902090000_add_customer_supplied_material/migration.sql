ALTER TABLE "tbl_mbomdetail"
  ADD COLUMN "material_supply_type" TEXT NOT NULL DEFAULT 'SUPPLIER_PURCHASE',
  ADD COLUMN "supply_customer_id" TEXT;

ALTER TABLE "tbl_mrp_requirement"
  ADD COLUMN "material_supply_type" TEXT NOT NULL DEFAULT 'SUPPLIER_PURCHASE',
  ADD COLUMN "supply_customer_code" TEXT;

ALTER TABLE "tbl_mbomdetail"
  ADD CONSTRAINT "tbl_mbomdetail_supply_customer_id_fkey"
  FOREIGN KEY ("supply_customer_id") REFERENCES "tbl_customer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tbl_mbomdetail_material_supply_type_idx"
  ON "tbl_mbomdetail"("material_supply_type");

CREATE INDEX "tbl_mbomdetail_supply_customer_id_idx"
  ON "tbl_mbomdetail"("supply_customer_id");

CREATE INDEX "tbl_mrp_requirement_material_supply_type_idx"
  ON "tbl_mrp_requirement"("material_supply_type");

CREATE INDEX "tbl_mrp_requirement_supply_customer_code_idx"
  ON "tbl_mrp_requirement"("supply_customer_code");
