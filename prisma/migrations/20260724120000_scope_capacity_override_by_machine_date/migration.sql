ALTER TABLE "tbl_capacity_day_override"
  ADD COLUMN IF NOT EXISTS "machine_id" TEXT;

DROP INDEX IF EXISTS "tbl_capacity_day_override_plan_id_schedule_date_key";
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_capacity_day_override_plan_id_machine_id_schedule_date_key"
  ON "tbl_capacity_day_override"("plan_id", "machine_id", "schedule_date");
CREATE INDEX IF NOT EXISTS "tbl_capacity_day_override_machine_id_idx"
  ON "tbl_capacity_day_override"("machine_id");

DO $$ BEGIN
  ALTER TABLE "tbl_capacity_day_override"
    ADD CONSTRAINT "tbl_capacity_day_override_machine_id_fkey"
    FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tbl_capacity_machine_override"
  ADD COLUMN IF NOT EXISTS "schedule_date" TIMESTAMP(3);
ALTER TABLE "tbl_capacity_machine_override"
  ADD COLUMN IF NOT EXISTS "dies_id" TEXT;

-- Existing overrides remain valid and are pinned to the plan period start.
UPDATE "tbl_capacity_machine_override" o
SET "schedule_date" = p."period_start"
FROM "tbl_monthly_production_plan" p
WHERE o."plan_id" = p."id" AND o."schedule_date" IS NULL;

ALTER TABLE "tbl_capacity_machine_override"
  ALTER COLUMN "schedule_date" SET NOT NULL;

DROP INDEX IF EXISTS "tbl_capacity_machine_override_plan_id_line_number_mbom_process_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_capacity_machine_override_plan_line_route_date_key"
  ON "tbl_capacity_machine_override"("plan_id", "line_number", "mbom_process_id", "schedule_date");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_schedule_date_idx"
  ON "tbl_capacity_machine_override"("schedule_date");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_dies_id_idx"
  ON "tbl_capacity_machine_override"("dies_id");

DO $$ BEGIN
  ALTER TABLE "tbl_capacity_machine_override"
    ADD CONSTRAINT "tbl_capacity_machine_override_dies_id_fkey"
    FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
