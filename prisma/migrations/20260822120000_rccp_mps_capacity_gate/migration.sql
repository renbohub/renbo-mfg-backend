ALTER TABLE "tbl_mps"
  ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "capacity_status" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
  ADD COLUMN IF NOT EXISTS "capacity_checked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "capacity_checked_by" TEXT,
  ADD COLUMN IF NOT EXISTS "rccp_invalidated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rccp_invalidation_reason" TEXT;

CREATE TABLE "tbl_rccp_resource_profile" (
  "id" TEXT NOT NULL,
  "part_id" TEXT NOT NULL,
  "resource_code" TEXT NOT NULL,
  "resource_name" TEXT,
  "machine_id" TEXT,
  "standard_time_hours" DOUBLE PRECISION NOT NULL,
  "setup_time_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "resource_count" INTEGER NOT NULL DEFAULT 1,
  "shifts_per_day" INTEGER NOT NULL DEFAULT 2,
  "effective_hours_per_shift" DOUBLE PRECISION NOT NULL DEFAULT 7,
  "efficiency_percent" DOUBLE PRECISION NOT NULL DEFAULT 85,
  "planned_downtime_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "calendar_mode" TEXT NOT NULL DEFAULT 'WEEKDAY',
  "is_critical" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_resource_profile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_resource_profile_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_rccp_resource_profile_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "tbl_rccp_run" (
  "id" TEXT NOT NULL,
  "mps_id" TEXT NOT NULL,
  "mps_revision" INTEGER NOT NULL,
  "planning_period" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "overall_load_status" TEXT NOT NULL DEFAULT 'RUNNING',
  "warning_threshold" DOUBLE PRECISION NOT NULL,
  "overload_threshold" DOUBLE PRECISION NOT NULL,
  "mps_qty_snapshot" DOUBLE PRECISION NOT NULL,
  "part_summaries" JSONB,
  "exceptions" JSONB,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "calculated_by" TEXT,
  "acknowledged_by" TEXT,
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_reason" TEXT,
  "invalidated_at" TIMESTAMP(3),
  "invalidation_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_run_mps_id_fkey" FOREIGN KEY ("mps_id") REFERENCES "tbl_mps"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "tbl_rccp_load" (
  "id" TEXT NOT NULL,
  "rccp_run_id" TEXT NOT NULL,
  "resource_profile_id" TEXT,
  "resource_code" TEXT NOT NULL,
  "resource_name" TEXT,
  "standard_time_hours" DOUBLE PRECISION NOT NULL,
  "setup_time_hours" DOUBLE PRECISION NOT NULL,
  "current_mps_load" DOUBLE PRECISION NOT NULL,
  "existing_load" DOUBLE PRECISION NOT NULL,
  "available_capacity" DOUBLE PRECISION NOT NULL,
  "total_load" DOUBLE PRECISION NOT NULL,
  "load_percentage" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL,
  "working_days" INTEGER NOT NULL,
  "shifts_per_day" INTEGER NOT NULL,
  "effective_hours_per_shift" DOUBLE PRECISION NOT NULL,
  "resource_count" INTEGER NOT NULL,
  "efficiency_percent" DOUBLE PRECISION NOT NULL,
  "planned_downtime_hours" DOUBLE PRECISION NOT NULL,
  "part_breakdown" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_load_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_load_rccp_run_id_fkey" FOREIGN KEY ("rccp_run_id") REFERENCES "tbl_rccp_run"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_rccp_load_resource_profile_id_fkey" FOREIGN KEY ("resource_profile_id") REFERENCES "tbl_rccp_resource_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "tbl_rccp_override" (
  "id" TEXT NOT NULL,
  "rccp_run_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "approved_by" TEXT NOT NULL,
  "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_override_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_override_rccp_run_id_fkey" FOREIGN KEY ("rccp_run_id") REFERENCES "tbl_rccp_run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_rccp_resource_profile_part_id_resource_code_key" ON "tbl_rccp_resource_profile"("part_id", "resource_code");
CREATE INDEX "tbl_rccp_resource_profile_resource_code_idx" ON "tbl_rccp_resource_profile"("resource_code");
CREATE INDEX "tbl_rccp_resource_profile_machine_id_idx" ON "tbl_rccp_resource_profile"("machine_id");
CREATE INDEX "tbl_rccp_resource_profile_is_active_is_critical_idx" ON "tbl_rccp_resource_profile"("is_active", "is_critical");
CREATE INDEX "tbl_rccp_run_mps_id_created_at_idx" ON "tbl_rccp_run"("mps_id", "created_at");
CREATE INDEX "tbl_rccp_run_planning_period_status_idx" ON "tbl_rccp_run"("planning_period", "status");
CREATE INDEX "tbl_rccp_run_invalidated_at_idx" ON "tbl_rccp_run"("invalidated_at");
CREATE UNIQUE INDEX "tbl_rccp_load_rccp_run_id_resource_code_key" ON "tbl_rccp_load"("rccp_run_id", "resource_code");
CREATE INDEX "tbl_rccp_load_resource_code_idx" ON "tbl_rccp_load"("resource_code");
CREATE INDEX "tbl_rccp_load_status_idx" ON "tbl_rccp_load"("status");
CREATE INDEX "tbl_rccp_override_rccp_run_id_idx" ON "tbl_rccp_override"("rccp_run_id");

INSERT INTO "tbl_system_settings" ("id", "setting_key", "setting_value", "description", "updated_by", "is_deleted", "created_at", "updated_at")
VALUES
  (gen_random_uuid()::text, 'RCCP_WARNING_THRESHOLD', '90', 'RCCP warning threshold percentage.', 'migration', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'RCCP_OVERLOAD_THRESHOLD', '100', 'RCCP overload threshold percentage.', 'migration', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'RCCP_DEFAULT_SETUP_HOURS', '0.25', 'Default setup allowance for routing-bootstrapped RCCP profiles.', 'migration', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("setting_key") DO NOTHING;

-- Initial governed profile for the active BRACKET COMP example in this step.
-- Future FG profiles can be created from routing through the RCCP bootstrap
-- service and then maintained independently.
INSERT INTO "tbl_rccp_resource_profile" (
  "id", "part_id", "resource_code", "resource_name", "standard_time_hours", "setup_time_hours",
  "resource_count", "shifts_per_day", "effective_hours_per_shift", "efficiency_percent",
  "planned_downtime_hours", "calendar_mode", "is_critical", "source", "notes", "created_by", "updated_by"
)
SELECT gen_random_uuid()::text, p."id", seed."resource_code", seed."resource_name", seed."standard_time_hours", seed."setup_time_hours",
  1, 2, 7, 85, CASE WHEN seed."resource_code" = 'STAMPING_MEDIUM' THEN 8 ELSE 0 END,
  'WEEKDAY', true, 'STEP_02_MPS_TO_RCCP', 'Initial RCCP critical-resource profile from approved Step 02 specification.', 'migration', 'migration'
FROM "tbl_part" p
CROSS JOIN (VALUES
  ('STAMPING_MEDIUM', 'Stamping Medium', 0.020::double precision, 0.50::double precision),
  ('WELDING_LINE_2', 'Welding Line 2', 0.015::double precision, 0.40::double precision),
  ('PAINTING_LINE', 'Painting Line', 0.010::double precision, 0.25::double precision)
) AS seed("resource_code", "resource_name", "standard_time_hours", "setup_time_hours")
WHERE p."part_code" = 'C002-C004-000'
ON CONFLICT ("part_id", "resource_code") DO NOTHING;

UPDATE "tbl_mps"
SET "capacity_status" = 'NOT_CHECKED',
    "capacity_checked_at" = NULL,
    "capacity_checked_by" = NULL,
    "lifecycle_status" = CASE WHEN "status" IN ('Draft', 'Confirmed') THEN 'CALCULATED' ELSE "lifecycle_status" END;
