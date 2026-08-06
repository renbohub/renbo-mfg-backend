-- Vendor routing is selected by PPIC at Capacity Planning. Persist that
-- selection explicitly through Daily Plan and optional Work Order trace.
ALTER TABLE "tbl_daily_production_schedule"
  ADD COLUMN IF NOT EXISTS "vendor_id" TEXT;

ALTER TABLE "tbl_work_order"
  ADD COLUMN IF NOT EXISTS "vendor_id" TEXT;

UPDATE "tbl_daily_production_schedule" schedule
SET "vendor_id" = allocation."vendor_id"
FROM "tbl_production_plan_allocation" allocation
WHERE allocation.id = schedule."production_plan_allocation_id"
  AND schedule."vendor_id" IS NULL
  AND allocation."vendor_id" IS NOT NULL;

UPDATE "tbl_work_order" work_order
SET "vendor_id" = schedule."vendor_id"
FROM "tbl_daily_production_schedule" schedule
WHERE schedule."wo_id" = work_order.id
  AND work_order."vendor_id" IS NULL
  AND schedule."vendor_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_vendor_id_idx"
  ON "tbl_daily_production_schedule"("vendor_id");
CREATE INDEX IF NOT EXISTS "tbl_work_order_vendor_id_idx"
  ON "tbl_work_order"("vendor_id");

DO $$ BEGIN
  ALTER TABLE "tbl_daily_production_schedule"
    ADD CONSTRAINT "tbl_daily_production_schedule_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "tbl_work_order"
    ADD CONSTRAINT "tbl_work_order_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
