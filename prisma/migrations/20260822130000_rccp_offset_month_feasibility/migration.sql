ALTER TABLE "tbl_rccp_resource_profile"
  ADD COLUMN IF NOT EXISTS "sequence" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "resource_type" TEXT NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN IF NOT EXISTS "lead_time_value" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "lead_time_unit" TEXT NOT NULL DEFAULT 'WORKING_DAY',
  ADD COLUMN IF NOT EXISTS "calendar_id" TEXT,
  ADD COLUMN IF NOT EXISTS "is_capacity_constrained" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "alternate_resource_code" TEXT;

ALTER TABLE "tbl_rccp_run"
  ADD COLUMN IF NOT EXISTS "earliest_start_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "latest_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "capacity_horizon_start" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "capacity_horizon_end" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "has_previous_month_load" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "offset_status" TEXT NOT NULL DEFAULT 'SAME_MONTH',
  ADD COLUMN IF NOT EXISTS "request_options" JSONB,
  ADD COLUMN IF NOT EXISTS "phase_summary" JSONB;

ALTER TABLE "tbl_rccp_load"
  ADD COLUMN IF NOT EXISTS "resource_type" TEXT NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN IF NOT EXISTS "load_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bucket_type" TEXT NOT NULL DEFAULT 'HORIZON',
  ADD COLUMN IF NOT EXISTS "bucket_start" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bucket_end" TIMESTAMP(3);

CREATE TABLE "tbl_rccp_time_bucket" (
  "id" TEXT NOT NULL,
  "rccp_run_id" TEXT NOT NULL,
  "resource_code" TEXT NOT NULL,
  "resource_name" TEXT,
  "resource_type" TEXT NOT NULL DEFAULT 'INTERNAL',
  "bucket_type" TEXT NOT NULL DEFAULT 'WEEKLY',
  "bucket_start" TIMESTAMP(3) NOT NULL,
  "bucket_end" TIMESTAMP(3) NOT NULL,
  "current_mps_load" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "existing_load" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "available_capacity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total_load" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "load_percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'FEASIBLE',
  "is_previous_month" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_time_bucket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_time_bucket_rccp_run_id_fkey" FOREIGN KEY ("rccp_run_id") REFERENCES "tbl_rccp_run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "tbl_rccp_offset_detail" (
  "id" TEXT NOT NULL,
  "rccp_run_id" TEXT NOT NULL,
  "mps_detail_id" TEXT NOT NULL,
  "mps_phase_id" TEXT,
  "part_code" TEXT NOT NULL,
  "phase_qty" DOUBLE PRECISION NOT NULL,
  "resource_profile_id" TEXT,
  "resource_code" TEXT NOT NULL,
  "resource_name" TEXT,
  "sequence" INTEGER NOT NULL,
  "resource_type" TEXT NOT NULL DEFAULT 'INTERNAL',
  "required_date" TIMESTAMP(3) NOT NULL,
  "calculated_start_date" TIMESTAMP(3) NOT NULL,
  "calculated_finish_date" TIMESTAMP(3) NOT NULL,
  "lead_time_value" DOUBLE PRECISION NOT NULL,
  "lead_time_unit" TEXT NOT NULL,
  "calendar_id" TEXT,
  "required_capacity_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "load_percentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'FEASIBLE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_offset_detail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_offset_detail_rccp_run_id_fkey" FOREIGN KEY ("rccp_run_id") REFERENCES "tbl_rccp_run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "tbl_rccp_recommendation" (
  "id" TEXT NOT NULL,
  "rccp_run_id" TEXT NOT NULL,
  "mps_detail_id" TEXT NOT NULL,
  "mps_phase_id" TEXT,
  "resource_code" TEXT NOT NULL,
  "alternate_resource_code" TEXT,
  "original_start_date" TIMESTAMP(3) NOT NULL,
  "recommended_start_date" TIMESTAMP(3) NOT NULL,
  "original_load_percentage" DOUBLE PRECISION NOT NULL,
  "recommended_load_percentage" DOUBLE PRECISION NOT NULL,
  "recommendation_type" TEXT NOT NULL DEFAULT 'EARLIER_START',
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "applied_by" TEXT,
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_rccp_recommendation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_rccp_recommendation_rccp_run_id_fkey" FOREIGN KEY ("rccp_run_id") REFERENCES "tbl_rccp_run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_rccp_time_bucket_rccp_run_id_resource_code_bucket_start_key" ON "tbl_rccp_time_bucket"("rccp_run_id", "resource_code", "bucket_start");
CREATE INDEX "tbl_rccp_time_bucket_rccp_run_id_bucket_start_idx" ON "tbl_rccp_time_bucket"("rccp_run_id", "bucket_start");
CREATE INDEX "tbl_rccp_time_bucket_resource_code_bucket_start_idx" ON "tbl_rccp_time_bucket"("resource_code", "bucket_start");
CREATE INDEX "tbl_rccp_offset_detail_rccp_run_id_mps_detail_id_mps_phase_id_idx" ON "tbl_rccp_offset_detail"("rccp_run_id", "mps_detail_id", "mps_phase_id");
CREATE INDEX "tbl_rccp_offset_detail_resource_code_calculated_start_date_idx" ON "tbl_rccp_offset_detail"("resource_code", "calculated_start_date");
CREATE INDEX "tbl_rccp_recommendation_rccp_run_id_status_idx" ON "tbl_rccp_recommendation"("rccp_run_id", "status");
CREATE INDEX "tbl_rccp_recommendation_resource_code_original_start_date_idx" ON "tbl_rccp_recommendation"("resource_code", "original_start_date");

INSERT INTO "tbl_system_settings" ("id", "setting_key", "setting_value", "description", "updated_by", "is_deleted", "created_at", "updated_at")
VALUES (gen_random_uuid()::text, 'RCCP_PREVIOUS_SEARCH_WINDOW_DAYS', '10', 'Working-day window used to find an earlier feasible RCCP start.', 'migration', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("setting_key") DO NOTHING;

UPDATE "tbl_rccp_resource_profile" profile
SET "sequence" = seed."sequence",
    "resource_type" = seed."resource_type",
    "lead_time_value" = seed."lead_time_value",
    "lead_time_unit" = 'WORKING_DAY',
    "calendar_id" = seed."calendar_id",
    "resource_code" = seed."new_resource_code",
    "resource_name" = seed."resource_name",
    "updated_by" = 'migration',
    "updated_at" = CURRENT_TIMESTAMP
FROM "tbl_part" part
JOIN (VALUES
  ('STAMPING_MEDIUM', 'STAMPING_MEDIUM', 'Stamping Medium', 10, 'INTERNAL', 1::double precision, 'FACTORY'),
  ('WELDING_LINE_2', 'WELDING_LINE_2', 'Welding Line 2', 20, 'INTERNAL', 1::double precision, 'FACTORY'),
  ('PAINTING_LINE', 'VENDOR_PAINT', 'Vendor Paint', 30, 'OUTSOURCE', 5::double precision, 'VENDOR')
) AS seed("old_resource_code", "new_resource_code", "resource_name", "sequence", "resource_type", "lead_time_value", "calendar_id") ON true
WHERE profile."part_id" = part."id"
  AND part."part_code" = 'C002-C004-000'
  AND profile."resource_code" = seed."old_resource_code";

INSERT INTO "tbl_rccp_resource_profile" (
  "id", "part_id", "resource_code", "resource_name", "standard_time_hours", "setup_time_hours",
  "resource_count", "shifts_per_day", "effective_hours_per_shift", "efficiency_percent", "planned_downtime_hours",
  "calendar_mode", "sequence", "resource_type", "lead_time_value", "lead_time_unit", "calendar_id",
  "is_capacity_constrained", "is_critical", "source", "notes", "created_by", "updated_by"
)
SELECT gen_random_uuid()::text, part."id", 'PACKING', 'Packing', 0.010, 0.20,
  1, 2, 7, 85, 0, 'WEEKDAY', 40, 'INTERNAL', 1, 'WORKING_DAY', 'FACTORY',
  true, true, 'STEP_02A_RCCP_OFFSET', 'Packing profile for time-phased RCCP.', 'migration', 'migration'
FROM "tbl_part" part
WHERE part."part_code" = 'C002-C004-000'
ON CONFLICT ("part_id", "resource_code") DO UPDATE SET
  "sequence" = EXCLUDED."sequence", "resource_type" = EXCLUDED."resource_type",
  "lead_time_value" = EXCLUDED."lead_time_value", "lead_time_unit" = EXCLUDED."lead_time_unit",
  "calendar_id" = EXCLUDED."calendar_id", "updated_by" = 'migration', "updated_at" = CURRENT_TIMESTAMP;

UPDATE "tbl_rccp_run"
SET "status" = 'INVALID', "invalidated_at" = CURRENT_TIMESTAMP,
    "invalidation_reason" = 'RCCP_INVALID_LEAD_TIME_CHANGED'
WHERE "invalidated_at" IS NULL;

UPDATE "tbl_mps"
SET "capacity_status" = 'NOT_CHECKED', "capacity_checked_at" = NULL, "capacity_checked_by" = NULL,
    "rccp_invalidated_at" = CURRENT_TIMESTAMP, "rccp_invalidation_reason" = 'RCCP_INVALID_LEAD_TIME_CHANGED',
    "lifecycle_status" = CASE WHEN "status" IN ('Draft', 'Confirmed') THEN 'CALCULATED' ELSE "lifecycle_status" END,
    "approved_by" = NULL, "approved_date" = NULL
WHERE "id" IN (SELECT DISTINCT "mps_id" FROM "tbl_rccp_run" WHERE "invalidation_reason" = 'RCCP_INVALID_LEAD_TIME_CHANGED');
