ALTER TABLE "tbl_stock_balance"
ADD COLUMN "uom_code" TEXT;

-- Backfill saldo lama dari mutasi terbaru dengan identitas/lokasi yang sama.
WITH movement_match AS (
  SELECT
    balance."id" AS "stock_balance_id",
    movement."uom_code",
    ROW_NUMBER() OVER (
      PARTITION BY balance."id"
      ORDER BY movement."movement_date" DESC, movement."created_at" DESC
    ) AS "row_number"
  FROM "tbl_stock_balance" AS balance
  JOIN "tbl_stock_movement" AS movement
    ON movement."warehouse_code" = balance."warehouse_code"
   AND movement."rack_code" IS NOT DISTINCT FROM balance."rack_code"
   AND movement."lot_number" IS NOT DISTINCT FROM balance."lot_number"
   AND movement."part_code" IS NOT DISTINCT FROM balance."part_code"
   AND movement."product_id" IS NOT DISTINCT FROM balance."product_id"
   AND movement."description" IS NOT DISTINCT FROM balance."description"
   AND movement."spec" IS NOT DISTINCT FROM balance."spec"
   AND movement."thickness" IS NOT DISTINCT FROM balance."thickness"
   AND movement."width" IS NOT DISTINCT FROM balance."width"
   AND movement."CSP" IS NOT DISTINCT FROM balance."CSP"
   AND movement."part_number" IS NOT DISTINCT FROM balance."part_number"
   AND movement."uom_code" IS NOT NULL
   AND movement."is_deleted" = FALSE
)
UPDATE "tbl_stock_balance" AS balance
SET "uom_code" = movement_match."uom_code"
FROM movement_match
WHERE movement_match."stock_balance_id" = balance."id"
  AND movement_match."row_number" = 1
  AND balance."uom_code" IS NULL;

DROP INDEX IF EXISTS "tbl_stock_balance_wh_rack_lot_identity_key";

CREATE UNIQUE INDEX "tbl_stock_balance_wh_rack_lot_identity_uom_key"
ON "tbl_stock_balance"(
  "warehouse_code",
  "rack_code",
  "lot_number",
  "part_code",
  "product_id",
  "description",
  "spec",
  "thickness",
  "width",
  "CSP",
  "part_number",
  "uom_code"
);

CREATE INDEX "tbl_stock_balance_uom_code_idx"
ON "tbl_stock_balance"("uom_code");
