-- Preserve the exact PPIC allocation/routing lineage through shop-floor execution.
ALTER TABLE "tbl_work_order"
  ADD COLUMN IF NOT EXISTS "mbom_process_id" TEXT;

ALTER TABLE "tbl_daily_production_schedule"
  ADD COLUMN IF NOT EXISTS "production_plan_id" TEXT,
  ADD COLUMN IF NOT EXISTS "production_plan_allocation_id" TEXT,
  ADD COLUMN IF NOT EXISTS "mbom_process_id" TEXT;

-- Existing generated schedules already carry the allocation id in their audit marker.
UPDATE "tbl_daily_production_schedule" dps
SET "production_plan_allocation_id" = marker.allocation_id
FROM (
  SELECT id,
         substring(notes FROM '\[PPIC-MPP-ALLOCATION:([^:\]]+):') AS allocation_id
  FROM "tbl_daily_production_schedule"
) marker
WHERE dps.id = marker.id
  AND marker.allocation_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "tbl_production_plan_allocation" allocation
    WHERE allocation.id = marker.allocation_id
  );

UPDATE "tbl_daily_production_schedule" dps
SET "production_plan_id" = allocation.plan_id,
    "mbom_process_id" = allocation.mbom_process_id
FROM "tbl_production_plan_allocation" allocation
WHERE allocation.id = dps.production_plan_allocation_id;

-- Best-effort legacy backfill. New records always persist the exact occurrence id.
UPDATE "tbl_work_order" wo
SET "mbom_process_id" = (
  SELECT process_route.id
  FROM "tbl_mbomprocess" process_route
  WHERE process_route.bom_detail_id = wo.mbom_detail_id
    AND process_route.process_id = wo.process_id
    AND process_route.is_deleted = false
  ORDER BY process_route.sequence, process_route.created_at
  LIMIT 1
)
WHERE wo.mbom_process_id IS NULL
  AND EXISTS (
    SELECT 1 FROM "tbl_mbomprocess" process_route
    WHERE process_route.bom_detail_id = wo.mbom_detail_id
      AND process_route.process_id = wo.process_id
      AND process_route.is_deleted = false
  );

UPDATE "tbl_daily_production_schedule" dps
SET "mbom_process_id" = wo.mbom_process_id
FROM "tbl_work_order" wo
WHERE dps.wo_id = wo.id
  AND dps.mbom_process_id IS NULL;

CREATE INDEX IF NOT EXISTS "tbl_work_order_mbom_process_id_idx"
  ON "tbl_work_order"("mbom_process_id");
CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_production_plan_id_idx"
  ON "tbl_daily_production_schedule"("production_plan_id");
CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_production_plan_allocation_id_idx"
  ON "tbl_daily_production_schedule"("production_plan_allocation_id");
CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_mbom_process_id_idx"
  ON "tbl_daily_production_schedule"("mbom_process_id");

ALTER TABLE "tbl_work_order"
  ADD CONSTRAINT "tbl_work_order_mbom_process_id_fkey"
  FOREIGN KEY ("mbom_process_id") REFERENCES "tbl_mbomprocess"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_daily_production_schedule"
  ADD CONSTRAINT "tbl_daily_production_schedule_production_plan_id_fkey"
  FOREIGN KEY ("production_plan_id") REFERENCES "tbl_monthly_production_plan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_daily_production_schedule"
  ADD CONSTRAINT "tbl_daily_production_schedule_production_plan_allocation_id_fkey"
  FOREIGN KEY ("production_plan_allocation_id") REFERENCES "tbl_production_plan_allocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_daily_production_schedule"
  ADD CONSTRAINT "tbl_daily_production_schedule_mbom_process_id_fkey"
  FOREIGN KEY ("mbom_process_id") REFERENCES "tbl_mbomprocess"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
