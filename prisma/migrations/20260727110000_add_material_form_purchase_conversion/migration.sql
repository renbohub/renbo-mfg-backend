-- Material-form procurement conversion.
-- All columns are additive; legacy lot_count/kg_per_lot/purchase_qty_kg remain
-- available and are used as a compatibility fallback.

ALTER TABLE "tbl_material"
  ADD COLUMN IF NOT EXISTS "default_purchase_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "default_conversion_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "default_conversion_factor" DOUBLE PRECISION;

ALTER TABLE "tbl_planned_order"
  ADD COLUMN IF NOT EXISTS "purchase_package_qty" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "purchase_package_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "conversion_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "conversion_factor" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "converted_purchase_qty" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_requisition_detail"
  ADD COLUMN IF NOT EXISTS "purchase_package_qty" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "purchase_package_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "conversion_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "conversion_factor" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "converted_purchase_qty" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_order_detail"
  ADD COLUMN IF NOT EXISTS "purchase_package_qty" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "purchase_package_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "conversion_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "conversion_factor" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "converted_purchase_qty" DOUBLE PRECISION;

UPDATE "tbl_material"
SET
  "default_purchase_uom_code" = CASE
    WHEN UPPER(COALESCE("material_form", '')) = 'SHEET' THEN 'SHEET'
    WHEN UPPER(COALESCE("material_form", '')) = 'COIL' THEN 'COIL'
    WHEN UPPER(COALESCE("material_form", '')) IN ('PIECES', 'PIECE', 'PCS') THEN 'PCS'
    ELSE "default_purchase_uom_code"
  END,
  "default_conversion_uom_code" = CASE
    WHEN UPPER(COALESCE("material_form", '')) IN ('PIECES', 'PIECE', 'PCS') THEN COALESCE("default_conversion_uom_code", 'PCS')
    WHEN UPPER(COALESCE("material_form", '')) IN ('SHEET', 'COIL') THEN COALESCE("default_conversion_uom_code", 'KG')
    ELSE "default_conversion_uom_code"
  END,
  "default_conversion_factor" = CASE
    WHEN UPPER(COALESCE("material_form", '')) IN ('PIECES', 'PIECE', 'PCS') THEN COALESCE("default_conversion_factor", 1)
    ELSE "default_conversion_factor"
  END
WHERE UPPER(COALESCE("material_form", '')) IN ('SHEET', 'COIL', 'PIECES', 'PIECE', 'PCS');

UPDATE "tbl_planned_order" po
SET
  "purchase_package_qty" = COALESCE(po."purchase_package_qty", po."lot_count"),
  "purchase_package_uom_code" = COALESCE(
    po."purchase_package_uom_code",
    CASE
      WHEN UPPER(COALESCE(m."material_form", '')) = 'SHEET' THEN 'SHEET'
      WHEN UPPER(COALESCE(m."material_form", '')) = 'COIL' THEN 'COIL'
      WHEN UPPER(COALESCE(m."material_form", '')) IN ('PIECES', 'PIECE', 'PCS') THEN 'PCS'
      ELSE 'LOT'
    END
  ),
  "conversion_uom_code" = COALESCE(po."conversion_uom_code", CASE WHEN po."purchase_qty_kg" IS NOT NULL THEN 'KG' END),
  "conversion_factor" = COALESCE(po."conversion_factor", po."kg_per_lot"),
  "converted_purchase_qty" = COALESCE(po."converted_purchase_qty", po."purchase_qty_kg")
FROM "tbl_part" p
LEFT JOIN "tbl_material" m ON m."id" = p."material_id"
WHERE po."part_id" = p."id"
  AND (po."lot_count" IS NOT NULL OR po."purchase_qty_kg" IS NOT NULL);

UPDATE "tbl_purchase_requisition_detail"
SET
  "purchase_package_qty" = COALESCE("purchase_package_qty", "lot_count"),
  "purchase_package_uom_code" = COALESCE("purchase_package_uom_code", 'LOT'),
  "conversion_uom_code" = COALESCE("conversion_uom_code", CASE WHEN "purchase_qty_kg" IS NOT NULL THEN 'KG' END),
  "conversion_factor" = COALESCE("conversion_factor", "kg_per_lot"),
  "converted_purchase_qty" = COALESCE("converted_purchase_qty", "purchase_qty_kg")
WHERE "lot_count" IS NOT NULL OR "purchase_qty_kg" IS NOT NULL;
