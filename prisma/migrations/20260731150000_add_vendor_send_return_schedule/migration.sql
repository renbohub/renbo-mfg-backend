ALTER TABLE "tbl_production_plan_allocation"
  ADD COLUMN IF NOT EXISTS "vendor_send_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vendor_return_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vendor_lead_time_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "expected_return_qty" DOUBLE PRECISION;

UPDATE "tbl_production_plan_allocation"
SET
  "vendor_send_date" = COALESCE("vendor_send_date", "schedule_date"),
  "vendor_return_date" = COALESCE("vendor_return_date", "schedule_date"),
  "vendor_lead_time_days" = COALESCE("vendor_lead_time_days", 0),
  "expected_return_qty" = COALESCE("expected_return_qty", "planned_qty")
WHERE "routing_mode" = 'VENDOR';

CREATE INDEX IF NOT EXISTS "tbl_production_plan_allocation_vendor_send_date_idx"
  ON "tbl_production_plan_allocation"("vendor_send_date");

CREATE INDEX IF NOT EXISTS "tbl_production_plan_allocation_vendor_return_date_idx"
  ON "tbl_production_plan_allocation"("vendor_return_date");
