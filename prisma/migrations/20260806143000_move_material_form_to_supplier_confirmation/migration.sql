ALTER TABLE "tbl_purchase_suggestion_item"
  ADD COLUMN "confirmed_material_width" DOUBLE PRECISION,
  ADD COLUMN "purchase_package_qty" DOUBLE PRECISION,
  ADD COLUMN "purchase_package_uom_code" TEXT,
  ADD COLUMN "conversion_uom_code" TEXT,
  ADD COLUMN "conversion_factor" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_suggestion_supplier_allocation"
  ADD COLUMN "material_width" DOUBLE PRECISION,
  ADD COLUMN "purchase_package_qty" DOUBLE PRECISION,
  ADD COLUMN "purchase_package_uom_code" TEXT,
  ADD COLUMN "conversion_uom_code" TEXT,
  ADD COLUMN "conversion_factor" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_requisition_sourcing_allocation"
  ADD COLUMN "material_width" DOUBLE PRECISION;
