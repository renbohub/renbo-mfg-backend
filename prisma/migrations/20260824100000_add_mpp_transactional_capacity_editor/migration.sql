-- Shift and effective-dated working hour masters.
CREATE TABLE "tbl_shift_master" (
  "id" TEXT NOT NULL, "shift_code" TEXT NOT NULL, "shift_name" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT, "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_shift_master_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_shift_master_shift_code_key" ON "tbl_shift_master"("shift_code");
CREATE INDEX "tbl_shift_master_sequence_idx" ON "tbl_shift_master"("sequence");
CREATE INDEX "tbl_shift_master_is_deleted_idx" ON "tbl_shift_master"("is_deleted");

CREATE TABLE "tbl_working_hour_profile" (
  "id" TEXT NOT NULL, "profile_code" TEXT NOT NULL, "profile_name" TEXT NOT NULL,
  "profile_type" TEXT NOT NULL DEFAULT 'REGULAR', "effective_from" TIMESTAMP(3),
  "effective_until" TIMESTAMP(3), "priority" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true, "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_working_hour_profile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_working_hour_profile_profile_code_key" ON "tbl_working_hour_profile"("profile_code");
CREATE INDEX "tbl_working_hour_profile_effective_from_effective_until_idx" ON "tbl_working_hour_profile"("effective_from", "effective_until");
CREATE INDEX "tbl_working_hour_profile_is_deleted_idx" ON "tbl_working_hour_profile"("is_deleted");

CREATE TABLE "tbl_working_hour_rule" (
  "id" TEXT NOT NULL, "profile_id" TEXT NOT NULL, "shift_id" TEXT NOT NULL,
  "day_of_week" INTEGER NOT NULL, "start_time" TEXT NOT NULL, "end_time" TEXT NOT NULL,
  "break_minutes" INTEGER NOT NULL DEFAULT 0, "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_working_hour_rule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_working_hour_rule_profile_id_shift_id_day_of_week_key" ON "tbl_working_hour_rule"("profile_id", "shift_id", "day_of_week");
CREATE INDEX "tbl_working_hour_rule_day_of_week_idx" ON "tbl_working_hour_rule"("day_of_week");
ALTER TABLE "tbl_working_hour_rule" ADD CONSTRAINT "tbl_working_hour_rule_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "tbl_working_hour_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_working_hour_rule" ADD CONSTRAINT "tbl_working_hour_rule_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "tbl_shift_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_machine" ADD COLUMN "working_hour_profile_id" TEXT;
ALTER TABLE "tbl_work_center" ADD COLUMN "working_hour_profile_id" TEXT;
CREATE INDEX "tbl_machine_working_hour_profile_id_idx" ON "tbl_machine"("working_hour_profile_id");
ALTER TABLE "tbl_machine" ADD CONSTRAINT "tbl_machine_working_hour_profile_id_fkey" FOREIGN KEY ("working_hour_profile_id") REFERENCES "tbl_working_hour_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_work_center" ADD CONSTRAINT "tbl_work_center_working_hour_profile_id_fkey" FOREIGN KEY ("working_hour_profile_id") REFERENCES "tbl_working_hour_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_capacity_day_override" ADD COLUMN "shift_overrides" JSONB;
ALTER TABLE "tbl_capacity_calendar_override" ADD COLUMN "shift_overrides" JSONB;
ALTER TABLE "tbl_vendor_pricelist_detail" ADD COLUMN "minimum_order_qty" DOUBLE PRECISION,
  ADD COLUMN "order_multiple_qty" DOUBLE PRECISION, ADD COLUMN "minimum_charge" DOUBLE PRECISION;

CREATE TABLE "tbl_capacity_edit_session" (
  "id" TEXT NOT NULL, "plan_id" TEXT NOT NULL, "scope" TEXT NOT NULL DEFAULT 'PLAN',
  "status" TEXT NOT NULL DEFAULT 'OPEN', "base_plan_updated_at" TIMESTAMP(3) NOT NULL,
  "snapshot" JSONB NOT NULL, "created_by" TEXT, "cancelled_by" TEXT,
  "cancelled_at" TIMESTAMP(3), "committed_by" TEXT, "committed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_capacity_edit_session_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tbl_capacity_edit_session_plan_id_status_idx" ON "tbl_capacity_edit_session"("plan_id", "status");
ALTER TABLE "tbl_capacity_edit_session" ADD CONSTRAINT "tbl_capacity_edit_session_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tbl_capacity_edit_change" (
  "id" TEXT NOT NULL, "session_id" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "change_type" TEXT NOT NULL, "entity_type" TEXT NOT NULL, "entity_id" TEXT,
  "before_value" JSONB, "after_value" JSONB NOT NULL,
  "force_required" BOOLEAN NOT NULL DEFAULT false, "force_reason" TEXT,
  "approval_status" TEXT NOT NULL DEFAULT 'NOT_REQUIRED', "approved_by" TEXT,
  "approved_at" TIMESTAMP(3), "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_capacity_edit_change_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tbl_capacity_edit_change_session_id_sequence_key" ON "tbl_capacity_edit_change"("session_id", "sequence");
CREATE INDEX "tbl_capacity_edit_change_entity_type_entity_id_idx" ON "tbl_capacity_edit_change"("entity_type", "entity_id");
ALTER TABLE "tbl_capacity_edit_change" ADD CONSTRAINT "tbl_capacity_edit_change_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tbl_capacity_edit_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tbl_capacity_queue_item" (
  "id" TEXT NOT NULL, "plan_id" TEXT NOT NULL, "session_id" TEXT,
  "source_allocation_id" TEXT, "line_number" INTEGER NOT NULL, "mbom_process_id" TEXT NOT NULL,
  "part_code" TEXT, "process_code" TEXT, "qty" DOUBLE PRECISION NOT NULL, "uom_code" TEXT,
  "earliest_start_date" TIMESTAMP(3), "latest_finish_date" TIMESTAMP(3), "fg_required_date" TIMESTAMP(3),
  "predecessor_ids" JSONB, "successor_ids" JSONB, "suggestions" JSONB,
  "status" TEXT NOT NULL DEFAULT 'OPEN', "reason" TEXT, "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_capacity_queue_item_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tbl_capacity_queue_item_plan_id_status_idx" ON "tbl_capacity_queue_item"("plan_id", "status");
CREATE INDEX "tbl_capacity_queue_item_session_id_idx" ON "tbl_capacity_queue_item"("session_id");
ALTER TABLE "tbl_capacity_queue_item" ADD CONSTRAINT "tbl_capacity_queue_item_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_capacity_queue_item" ADD CONSTRAINT "tbl_capacity_queue_item_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "tbl_capacity_edit_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "tbl_shift_master" ("id", "shift_code", "shift_name", "sequence", "updated_at") VALUES
  ('system-shift-1', 'SHIFT-1', 'Shift 1', 1, CURRENT_TIMESTAMP),
  ('system-shift-2', 'SHIFT-2', 'Shift 2', 2, CURRENT_TIMESTAMP)
ON CONFLICT ("shift_code") DO NOTHING;
