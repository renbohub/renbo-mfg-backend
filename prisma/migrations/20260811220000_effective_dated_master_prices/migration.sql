-- Additive effective-dated master pricing. Legacy year/month columns are kept
-- intact and remain available to the compatibility resolver.
ALTER TABLE "tbl_part_pricelist"
  ADD COLUMN IF NOT EXISTS "unit_price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "effective_from" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "effective_until" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "created_by" TEXT;

ALTER TABLE "tbl_material_pricelist"
  ADD COLUMN IF NOT EXISTS "unit_price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "purchase_package_uom_code" TEXT,
  ADD COLUMN IF NOT EXISTS "moq" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "order_multiple" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "effective_from" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "effective_until" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "created_by" TEXT;

ALTER TABLE "tbl_product_pricelist"
  ADD COLUMN IF NOT EXISTS "unit_price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "effective_from" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "effective_until" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "created_by" TEXT;

ALTER TABLE "tbl_vendor_pricelist"
  ADD COLUMN IF NOT EXISTS "effective_from" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "effective_until" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "created_by" TEXT;

ALTER TABLE "tbl_vendor_pricelist_detail"
  ADD COLUMN IF NOT EXISTS "unit_price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "uom_code" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_part_pricelist_effective_from_effective_until_idx"
  ON "tbl_part_pricelist"("effective_from", "effective_until");
CREATE INDEX IF NOT EXISTS "tbl_material_pricelist_effective_from_effective_until_idx"
  ON "tbl_material_pricelist"("effective_from", "effective_until");
CREATE INDEX IF NOT EXISTS "tbl_product_pricelist_effective_from_effective_until_idx"
  ON "tbl_product_pricelist"("effective_from", "effective_until");
CREATE INDEX IF NOT EXISTS "tbl_vendor_pricelist_effective_from_effective_until_idx"
  ON "tbl_vendor_pricelist"("effective_from", "effective_until");

-- Transaction snapshot: changing a master price later must never rewrite an
-- already generated purchase suggestion.
ALTER TABLE "tbl_purchase_suggestion_item"
  ADD COLUMN IF NOT EXISTS "price_source" TEXT,
  ADD COLUMN IF NOT EXISTS "price_effective_from" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "price_effective_until" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "tbl_machine_cost_rate" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "unit_price" DOUBLE PRECISION NOT NULL,
  "costing_rate_type" TEXT NOT NULL DEFAULT 'PER_HOUR',
  "currency_code" TEXT NOT NULL DEFAULT 'IDR',
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_until" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_machine_cost_rate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_machine_cost_rate_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tbl_machine_cost_rate_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "tbl_machine_cost_rate_machine_id_effective_from_effective_until_idx"
  ON "tbl_machine_cost_rate"("machine_id", "effective_from", "effective_until");
CREATE INDEX IF NOT EXISTS "tbl_machine_cost_rate_currency_code_idx" ON "tbl_machine_cost_rate"("currency_code");
CREATE INDEX IF NOT EXISTS "tbl_machine_cost_rate_is_deleted_idx" ON "tbl_machine_cost_rate"("is_deleted");
