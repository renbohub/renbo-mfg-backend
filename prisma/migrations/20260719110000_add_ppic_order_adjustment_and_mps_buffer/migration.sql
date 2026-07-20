ALTER TABLE "tbl_mps_detail"
  ADD COLUMN IF NOT EXISTS "forecast_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actual_sales_order_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_base_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "effective_demand_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "tbl_mrp_requirement"
  ADD COLUMN IF NOT EXISTS "order_percent" DOUBLE PRECISION NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "adjusted_order_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "tbl_mps_detail" d
SET "forecast_qty" = d."qty_planned",
    "effective_demand_qty" = d."qty_planned",
    "buffer_percent" = COALESCE(p."buffer_stock", 0)
FROM "tbl_part" p
WHERE d."part_id" = p."id"
  AND d."forecast_qty" = 0
  AND d."is_deleted" = false;

WITH next_forecast AS (
  SELECT id,
         LEAD("forecast_qty", 1, 0) OVER (PARTITION BY "mps_number", "part_code" ORDER BY "start_date", "line_number") AS next_qty
  FROM "tbl_mps_detail"
  WHERE "is_deleted" = false
    AND COALESCE("notes", '') NOT LIKE '[MRP-PRODUCTION]%'
)
UPDATE "tbl_mps_detail" d
SET "buffer_base_qty" = n.next_qty,
    "buffer_qty" = ROUND((n.next_qty * d."buffer_percent" / 100.0)::numeric, 6),
    "effective_demand_qty" = d."forecast_qty" + ROUND((n.next_qty * d."buffer_percent" / 100.0)::numeric, 6),
    "qty_planned" = d."forecast_qty" + ROUND((n.next_qty * d."buffer_percent" / 100.0)::numeric, 6)
FROM next_forecast n
WHERE d.id = n.id;

UPDATE "tbl_mrp_requirement"
SET "adjusted_order_qty" = "planned_order_qty"
WHERE "adjusted_order_qty" = 0
  AND "planned_order_qty" > 0;
