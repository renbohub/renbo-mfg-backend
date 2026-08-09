ALTER TABLE "tbl_production_plan_allocation"
  ADD COLUMN IF NOT EXISTS "dies_id" TEXT;

ALTER TABLE "tbl_daily_production_schedule"
  ADD COLUMN IF NOT EXISTS "dies_id" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tbl_production_plan_allocation_dies_id_fkey') THEN
    ALTER TABLE "tbl_production_plan_allocation"
      ADD CONSTRAINT "tbl_production_plan_allocation_dies_id_fkey"
      FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tbl_daily_production_schedule_dies_id_fkey') THEN
    ALTER TABLE "tbl_daily_production_schedule"
      ADD CONSTRAINT "tbl_daily_production_schedule_dies_id_fkey"
      FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tbl_production_plan_allocation_dies_id_idx"
  ON "tbl_production_plan_allocation"("dies_id");

CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_dies_id_idx"
  ON "tbl_daily_production_schedule"("dies_id");

UPDATE "tbl_production_plan_allocation" AS allocation
SET "dies_id" = process."dies_id"
FROM "tbl_mbomprocess" AS process
WHERE allocation."mbom_process_id" = process."id"
  AND allocation."dies_id" IS NULL
  AND process."dies_id" IS NOT NULL;

UPDATE "tbl_daily_production_schedule" AS schedule
SET "dies_id" = COALESCE(
  (SELECT allocation."dies_id" FROM "tbl_production_plan_allocation" AS allocation WHERE allocation."id" = schedule."production_plan_allocation_id"),
  (SELECT work_order."dies_id" FROM "tbl_work_order" AS work_order WHERE work_order."id" = schedule."wo_id"),
  (SELECT process."dies_id" FROM "tbl_mbomprocess" AS process WHERE process."id" = schedule."mbom_process_id")
)
WHERE schedule."dies_id" IS NULL;
