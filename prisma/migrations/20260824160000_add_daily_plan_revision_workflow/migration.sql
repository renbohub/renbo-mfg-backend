CREATE TABLE "tbl_daily_plan_revision" (
  "id" TEXT NOT NULL,
  "revision_number" TEXT NOT NULL,
  "plan_date" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "source_production_plan_id" TEXT,
  "source_plan_number" TEXT,
  "supersedes_id" TEXT,
  "validation_summary" JSONB,
  "warning_reason" TEXT,
  "prepared_by" TEXT,
  "prepared_at" TIMESTAMP(3),
  "released_by" TEXT,
  "released_at" TIMESTAMP(3),
  "revision_reason" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_daily_plan_revision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_daily_plan_revision_revision_number_key" ON "tbl_daily_plan_revision"("revision_number");
CREATE INDEX "tbl_daily_plan_revision_plan_date_status_idx" ON "tbl_daily_plan_revision"("plan_date", "status");
CREATE INDEX "tbl_daily_plan_revision_source_production_plan_id_idx" ON "tbl_daily_plan_revision"("source_production_plan_id");
CREATE INDEX "tbl_daily_plan_revision_supersedes_id_idx" ON "tbl_daily_plan_revision"("supersedes_id");
CREATE INDEX "tbl_daily_plan_revision_is_deleted_idx" ON "tbl_daily_plan_revision"("is_deleted");

ALTER TABLE "tbl_daily_production_schedule" ADD COLUMN "daily_plan_revision_id" TEXT;
CREATE INDEX "tbl_daily_production_schedule_daily_plan_revision_id_idx" ON "tbl_daily_production_schedule"("daily_plan_revision_id");
ALTER TABLE "tbl_daily_production_schedule" ADD CONSTRAINT "tbl_daily_production_schedule_daily_plan_revision_id_fkey" FOREIGN KEY ("daily_plan_revision_id") REFERENCES "tbl_daily_plan_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "tbl_daily_planning_exception" (
  "id" TEXT NOT NULL, "exception_key" TEXT NOT NULL, "plan_date" TIMESTAMP(3) NOT NULL,
  "exception_type" TEXT NOT NULL, "severity" TEXT NOT NULL DEFAULT 'WARNING', "state" TEXT NOT NULL DEFAULT 'OPEN',
  "source_type" TEXT NOT NULL, "source_id" TEXT NOT NULL, "machine_id" TEXT, "part_code" TEXT,
  "process_code" TEXT, "qty" DOUBLE PRECISION, "uom_code" TEXT, "earliest_date" TIMESTAMP(3),
  "latest_date" TIMESTAMP(3), "fg_required_date" TIMESTAMP(3), "suggestions" JSONB,
  "applied_revision_id" TEXT, "applied_schedule_id" TEXT, "ignored_reason" TEXT, "handled_by" TEXT,
  "handled_at" TIMESTAMP(3), "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_daily_planning_exception_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_daily_planning_exception_exception_key_key" ON "tbl_daily_planning_exception"("exception_key");
CREATE INDEX "tbl_daily_planning_exception_plan_date_state_idx" ON "tbl_daily_planning_exception"("plan_date", "state");
CREATE INDEX "tbl_daily_planning_exception_source_type_source_id_idx" ON "tbl_daily_planning_exception"("source_type", "source_id");
CREATE INDEX "tbl_daily_planning_exception_machine_id_idx" ON "tbl_daily_planning_exception"("machine_id");
CREATE INDEX "tbl_daily_planning_exception_is_deleted_idx" ON "tbl_daily_planning_exception"("is_deleted");

CREATE TABLE "tbl_machine_availability_event" (
  "id" TEXT NOT NULL, "machine_id" TEXT NOT NULL, "event_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN', "started_at" TIMESTAMP(3) NOT NULL, "ended_at" TIMESTAMP(3),
  "reason" TEXT NOT NULL, "reported_by" TEXT, "resolved_by" TEXT, "resolved_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "tbl_machine_availability_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tbl_machine_availability_event_machine_id_started_at_idx" ON "tbl_machine_availability_event"("machine_id", "started_at");
CREATE INDEX "tbl_machine_availability_event_status_idx" ON "tbl_machine_availability_event"("status");
CREATE INDEX "tbl_machine_availability_event_is_deleted_idx" ON "tbl_machine_availability_event"("is_deleted");
