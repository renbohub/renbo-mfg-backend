-- Material Form is selected per BOM scheme. Preserve the legacy selection on
-- existing BOM rows before removing it from Material Master identity.
UPDATE "tbl_mbomdetail" AS d
SET "material_form_id" = m."material_form_id",
    "updated_at" = NOW()
FROM "tbl_part" AS p
JOIN "tbl_material" AS m ON m."id" = p."material_id"
WHERE d."part_id" = p."id"
  AND d."material_form_id" IS NULL
  AND p."item_type" = 'RAW'
  AND p."raw_type" = 'MATERIAL'
  AND m."material_form_id" IS NOT NULL;

CREATE TEMP TABLE "_tmp_material_merge" (
  "duplicate_id" TEXT PRIMARY KEY,
  "survivor_id" TEXT NOT NULL
);

INSERT INTO "_tmp_material_merge" ("duplicate_id", "survivor_id")
SELECT "id", "survivor_id"
FROM (
  SELECT
    m."id",
    FIRST_VALUE(m."id") OVER (
      PARTITION BY m."material_substance_id", m."material_grade_id", m."width"
      ORDER BY m."created_at", m."id"
    ) AS "survivor_id",
    ROW_NUMBER() OVER (
      PARTITION BY m."material_substance_id", m."material_grade_id", m."width"
      ORDER BY m."created_at", m."id"
    ) AS "row_number"
  FROM "tbl_material" AS m
  WHERE m."is_deleted" = FALSE
    AND m."material_substance_id" IS NOT NULL
    AND m."material_grade_id" IS NOT NULL
    AND m."width" IS NOT NULL
) ranked
WHERE "row_number" > 1;

-- Avoid the attribute unique key before redirecting material references.
DELETE FROM "tbl_material_attribute_value" AS duplicate_value
USING "_tmp_material_merge" AS merge_map
WHERE duplicate_value."material_id" = merge_map."duplicate_id"
  AND EXISTS (
    SELECT 1
    FROM "tbl_material_attribute_value" AS survivor_value
    WHERE survivor_value."material_id" = merge_map."survivor_id"
      AND survivor_value."attribute_definition_id" = duplicate_value."attribute_definition_id"
  );

UPDATE "tbl_material_attribute_value" AS row SET "material_id" = map."survivor_id" FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_material_pricelist" AS row SET "material_id" = map."survivor_id" FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_part" AS row SET "material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_lot_master" AS row SET "material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_stock_balance" AS row SET "material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_stock_movement" AS row SET "material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_purchase_requisition_detail" AS row SET "material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_purchase_order_detail" AS row SET "material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."material_id" = map."duplicate_id";
UPDATE "tbl_purchase_requisition" AS row SET "header_material_id" = map."survivor_id", "updated_at" = NOW() FROM "_tmp_material_merge" AS map WHERE row."header_material_id" = map."duplicate_id";

-- Archive duplicate rows instead of hard-deleting transaction history.
UPDATE "tbl_material" AS duplicate
SET "material_code" = duplicate."material_code" || '-DUP-' || SUBSTRING(duplicate."id" FROM 1 FOR 8),
    "is_deleted" = TRUE,
    "material_form_id" = NULL,
    "material_form" = NULL,
    "CSP" = NULL,
    "default_purchase_uom_code" = NULL,
    "default_conversion_uom_code" = NULL,
    "default_conversion_factor" = NULL,
    "updated_at" = NOW()
FROM "_tmp_material_merge" AS map
WHERE duplicate."id" = map."duplicate_id";

-- Rebuild the canonical active Material Code without C/S/P.
UPDATE "tbl_material"
SET "material_code" = CONCAT_WS(
      '-',
      NULLIF(UPPER(REGEXP_REPLACE(TRIM("spec"), '\s+', '', 'g')), ''),
      NULLIF("thickness"::NUMERIC::TEXT, ''),
      NULLIF("width"::NUMERIC::TEXT, '')
    ),
    "material_form_id" = NULL,
    "material_form" = NULL,
    "CSP" = NULL,
    "default_purchase_uom_code" = NULL,
    "default_conversion_uom_code" = NULL,
    "default_conversion_factor" = NULL,
    "updated_at" = NOW()
WHERE "is_deleted" = FALSE;

UPDATE "tbl_purchase_requisition_detail" AS detail
SET "material_code" = material."material_code",
    "updated_at" = NOW()
FROM "tbl_material" AS material
WHERE detail."material_id" = material."id"
  AND detail."is_deleted" = FALSE;

UPDATE "tbl_purchase_requisition" AS pr
SET "header_material_code" = material."material_code",
    "updated_at" = NOW()
FROM "tbl_material" AS material
WHERE pr."header_material_id" = material."id"
  AND pr."is_deleted" = FALSE;

CREATE UNIQUE INDEX "tbl_material_active_substance_grade_width_key"
ON "tbl_material" ("material_substance_id", "material_grade_id", "width")
WHERE "is_deleted" = FALSE
  AND "material_substance_id" IS NOT NULL
  AND "material_grade_id" IS NOT NULL
  AND "width" IS NOT NULL;

-- Guarantees one open system-generated material PR per Material/period/location,
-- even when two MRP runs are released concurrently.
CREATE UNIQUE INDEX "tbl_pr_open_material_bucket_warehouse_key"
ON "tbl_purchase_requisition" ("header_material_id", "demand_bucket", COALESCE("warehouse_code", ''))
WHERE "is_deleted" = FALSE
  AND "status" = 'Draft'
  AND "source_type" = 'SYSTEM'
  AND "procurement_group" = 'MATERIAL'
  AND "header_material_id" IS NOT NULL;

CREATE TABLE "tbl_purchase_requisition_demand_allocation" (
  "id" TEXT NOT NULL,
  "pr_detail_id" TEXT NOT NULL,
  "customer_code" TEXT,
  "customer_name" TEXT,
  "planned_order_number" TEXT,
  "mrp_run_number" TEXT,
  "mps_number" TEXT,
  "forecast_number" TEXT,
  "so_number" TEXT,
  "qty" DOUBLE PRECISION NOT NULL,
  "uom_code" TEXT,
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_purchase_requisition_demand_allocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_purchase_requisition_demand_allocation_pr_detail_id_fkey"
    FOREIGN KEY ("pr_detail_id") REFERENCES "tbl_purchase_requisition_detail"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tbl_purchase_requisition_demand_allocation_pr_detail_id_idx" ON "tbl_purchase_requisition_demand_allocation"("pr_detail_id");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_customer_code_idx" ON "tbl_purchase_requisition_demand_allocation"("customer_code");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_planned_order_number_idx" ON "tbl_purchase_requisition_demand_allocation"("planned_order_number");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_mrp_run_number_idx" ON "tbl_purchase_requisition_demand_allocation"("mrp_run_number");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_mps_number_idx" ON "tbl_purchase_requisition_demand_allocation"("mps_number");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_forecast_number_idx" ON "tbl_purchase_requisition_demand_allocation"("forecast_number");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_so_number_idx" ON "tbl_purchase_requisition_demand_allocation"("so_number");
CREATE INDEX "tbl_purchase_requisition_demand_allocation_is_deleted_idx" ON "tbl_purchase_requisition_demand_allocation"("is_deleted");

-- Existing PRs start EXACT according to their MRP source pegging. Users may
-- later split or change these rows freely; variance remains informational.
INSERT INTO "tbl_purchase_requisition_demand_allocation" (
  "id", "pr_detail_id", "customer_code", "customer_name",
  "planned_order_number", "mrp_run_number", "mps_number",
  "forecast_number", "so_number", "qty", "uom_code", "notes",
  "is_deleted", "created_at", "updated_at"
)
SELECT
  source."id" || '-ALLOC',
  source."pr_detail_id",
  mps_detail."customer_code",
  customer."customer_name",
  source."planned_order_number",
  source."mrp_run_number",
  source."mps_number",
  source."forecast_number",
  source."so_number",
  source."qty",
  source."uom_code",
  'Backfill alokasi customer dari trace MRP',
  FALSE,
  NOW(),
  NOW()
FROM "tbl_purchase_requisition_source" AS source
LEFT JOIN "tbl_mps_detail" AS mps_detail ON mps_detail."id" = source."mps_detail_id"
LEFT JOIN "tbl_customer" AS customer ON customer."customer_code" = mps_detail."customer_code"
WHERE source."is_deleted" = FALSE
  AND source."qty" > 0;
