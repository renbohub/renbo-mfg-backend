ALTER TABLE "tbl_planned_order"
ADD COLUMN IF NOT EXISTS "qty_released" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "tbl_planned_order"
SET "qty_released" = CASE
  WHEN "status" IN ('Released', 'Covered') THEN GREATEST(COALESCE("qty", 0), 0)
  ELSE 0
END
WHERE "qty_released" = 0;

UPDATE "tbl_monthly_production_plan_detail" AS detail
SET "uom_code" = COALESCE(part."production_uom_code", part."base_uom_code")
FROM "tbl_part" AS part
WHERE detail."part_id" = part."id"
  AND detail."uom_code" IS NULL
  AND COALESCE(part."production_uom_code", part."base_uom_code") IS NOT NULL;

WITH canonical_work_order_sequence AS (
  SELECT
    work_order."id",
    ROW_NUMBER() OVER (
      PARTITION BY work_order."mo_id"
      ORDER BY
        COALESCE(
          NULLIF(REGEXP_REPLACE(process."routing_number", '[^0-9]', '', 'g'), '')::INTEGER,
          2147483647
        ),
        process."sequence",
        process."created_at",
        work_order."created_at"
    ) * 10 AS canonical_sequence
  FROM "tbl_work_order" AS work_order
  JOIN "tbl_mbomprocess" AS process
    ON process."bom_detail_id" = work_order."mbom_detail_id"
   AND process."process_id" = work_order."process_id"
   AND process."is_deleted" = false
  WHERE work_order."is_deleted" = false
)
UPDATE "tbl_work_order" AS work_order
SET "sequence" = canonical.canonical_sequence
FROM canonical_work_order_sequence AS canonical
WHERE work_order."id" = canonical."id";

UPDATE "tbl_daily_production_schedule" AS schedule
SET "sequence" = work_order."sequence"
FROM "tbl_work_order" AS work_order
WHERE schedule."wo_id" = work_order."id"
  AND schedule."is_deleted" = false
  AND work_order."is_deleted" = false;
