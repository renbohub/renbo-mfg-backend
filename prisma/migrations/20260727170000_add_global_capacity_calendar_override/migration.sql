CREATE TABLE IF NOT EXISTS "tbl_capacity_calendar_override" (
  "id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "schedule_date" TIMESTAMP(3) NOT NULL,
  "day_status" TEXT NOT NULL DEFAULT 'WORKING',
  "shifts_per_day" INTEGER,
  "overtime_start" TEXT,
  "overtime_end" TEXT,
  "reason" TEXT,
  "changed_by" TEXT,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_capacity_calendar_override_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_capacity_calendar_override_machine_id_fkey"
    FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_capacity_calendar_override_machine_date_key"
  ON "tbl_capacity_calendar_override"("machine_id", "schedule_date");
CREATE INDEX IF NOT EXISTS "tbl_capacity_calendar_override_schedule_date_idx"
  ON "tbl_capacity_calendar_override"("schedule_date");
CREATE INDEX IF NOT EXISTS "tbl_capacity_calendar_override_is_deleted_idx"
  ON "tbl_capacity_calendar_override"("is_deleted");
