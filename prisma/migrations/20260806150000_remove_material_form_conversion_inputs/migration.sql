ALTER TABLE "tbl_purchase_suggestion_item"
  DROP COLUMN "purchase_package_qty",
  DROP COLUMN "conversion_uom_code",
  DROP COLUMN "conversion_factor";

ALTER TABLE "tbl_purchase_suggestion_supplier_allocation"
  DROP COLUMN "purchase_package_qty",
  DROP COLUMN "conversion_uom_code",
  DROP COLUMN "conversion_factor";
