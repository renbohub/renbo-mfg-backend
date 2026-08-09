ALTER TABLE "tbl_daily_production_schedule"
  ADD COLUMN "schedule_priority" INTEGER NOT NULL DEFAULT 100;

CREATE INDEX "tbl_daily_production_schedule_schedule_date_schedule_priority_idx"
  ON "tbl_daily_production_schedule"("schedule_date", "schedule_priority");

CREATE TABLE "tbl_production_log_carryover" (
  "id" TEXT NOT NULL,
  "source_log_id" TEXT NOT NULL,
  "source_dps_id" TEXT NOT NULL,
  "target_date" TIMESTAMP(3) NOT NULL,
  "shortfall_qty" DOUBLE PRECISION NOT NULL,
  "allocated_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "target_allocations" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ALLOCATED',
  "created_by" TEXT,
  "reversed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_production_log_carryover_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_production_log_carryover_source_log_id_fkey"
    FOREIGN KEY ("source_log_id") REFERENCES "tbl_production_log"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_production_log_carryover_source_log_id_key"
  ON "tbl_production_log_carryover"("source_log_id");
CREATE INDEX "tbl_production_log_carryover_source_dps_id_idx"
  ON "tbl_production_log_carryover"("source_dps_id");
CREATE INDEX "tbl_production_log_carryover_target_date_idx"
  ON "tbl_production_log_carryover"("target_date");
CREATE INDEX "tbl_production_log_carryover_status_idx"
  ON "tbl_production_log_carryover"("status");
