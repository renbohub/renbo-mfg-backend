-- Wave 1 compatibility foundation. Additive only: no legacy record is changed or removed.
ALTER TABLE "tbl_part"
  ADD COLUMN IF NOT EXISTS "item_class" TEXT,
  ADD COLUMN IF NOT EXISTS "procurement_type" TEXT,
  ADD COLUMN IF NOT EXISTS "base_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "purchase_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "stock_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "production_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "sales_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "default_warehouse_id" TEXT,
  ADD COLUMN IF NOT EXISTS "safety_stock" DOUBLE PRECISION;
ALTER TABLE "tbl_uom" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "tbl_warehouse"
  ADD COLUMN IF NOT EXISTS "available_for_mrp" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "available_for_production" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "available_for_delivery" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "stock_status" TEXT NOT NULL DEFAULT 'AVAILABLE';

CREATE TABLE IF NOT EXISTS "tbl_material_attribute_set" (
  "id" TEXT PRIMARY KEY, "set_code" TEXT NOT NULL UNIQUE, "set_name" TEXT NOT NULL, "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "tbl_material_attribute_definition" (
  "id" TEXT PRIMARY KEY, "attribute_set_id" TEXT NOT NULL, "attribute_code" TEXT NOT NULL, "attribute_name" TEXT NOT NULL,
  "data_type" TEXT NOT NULL DEFAULT 'TEXT', "unit_code" TEXT, "is_required" BOOLEAN NOT NULL DEFAULT false,
  "sequence" INTEGER NOT NULL DEFAULT 0, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_attribute_definition_set_fkey" FOREIGN KEY ("attribute_set_id") REFERENCES "tbl_material_attribute_set"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_material_attribute_definition_set_code_key" UNIQUE ("attribute_set_id", "attribute_code")
);
CREATE TABLE IF NOT EXISTS "tbl_material_attribute_value" (
  "id" TEXT PRIMARY KEY, "material_id" TEXT NOT NULL, "attribute_definition_id" TEXT NOT NULL,
  "value_text" TEXT, "value_number" DOUBLE PRECISION, "value_boolean" BOOLEAN,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_attribute_value_material_fkey" FOREIGN KEY ("material_id") REFERENCES "tbl_material"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_material_attribute_value_definition_fkey" FOREIGN KEY ("attribute_definition_id") REFERENCES "tbl_material_attribute_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_material_attribute_value_material_definition_key" UNIQUE ("material_id", "attribute_definition_id")
);
CREATE TABLE IF NOT EXISTS "tbl_uom_conversion" (
  "id" TEXT PRIMARY KEY, "from_uom_code" TEXT NOT NULL, "to_uom_code" TEXT NOT NULL, "factor" DOUBLE PRECISION NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_uom_conversion_from_fkey" FOREIGN KEY ("from_uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tbl_uom_conversion_to_fkey" FOREIGN KEY ("to_uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tbl_uom_conversion_pair_key" UNIQUE ("from_uom_code", "to_uom_code")
);
CREATE TABLE IF NOT EXISTS "tbl_item_uom_mapping" (
  "id" TEXT PRIMARY KEY, "part_id" TEXT NOT NULL, "uom_code" TEXT NOT NULL, "usage_type" TEXT NOT NULL DEFAULT 'STOCK',
  "factor" DOUBLE PRECISION NOT NULL DEFAULT 1, "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_item_uom_mapping_part_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_item_uom_mapping_uom_fkey" FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tbl_item_uom_mapping_key" UNIQUE ("part_id", "uom_code", "usage_type")
);
CREATE TABLE IF NOT EXISTS "tbl_supplier_item" (
  "id" TEXT PRIMARY KEY, "supplier_id" TEXT NOT NULL, "part_id" TEXT NOT NULL, "supplier_item_code" TEXT,
  "lead_time_days" INTEGER, "moq" DOUBLE PRECISION, "order_multiple" DOUBLE PRECISION, "pack_size" DOUBLE PRECISION,
  "purchase_uom_code" TEXT, "is_preferred" BOOLEAN NOT NULL DEFAULT false, "priority" INTEGER NOT NULL DEFAULT 100,
  "price" DOUBLE PRECISION, "currency_code" TEXT, "valid_from" TIMESTAMP(3), "valid_until" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_supplier_item_supplier_fkey" FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_supplier_item_part_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_supplier_item_key" UNIQUE ("supplier_id", "part_id", "supplier_item_code")
);

CREATE INDEX IF NOT EXISTS "tbl_part_item_class_idx" ON "tbl_part"("item_class");
CREATE INDEX IF NOT EXISTS "tbl_part_procurement_type_idx" ON "tbl_part"("procurement_type");
CREATE INDEX IF NOT EXISTS "tbl_supplier_item_supplier_idx" ON "tbl_supplier_item"("supplier_id");
CREATE INDEX IF NOT EXISTS "tbl_supplier_item_part_idx" ON "tbl_supplier_item"("part_id");
