ALTER TABLE "tbl_dies" ADD COLUMN IF NOT EXISTS "dies_type" TEXT;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "default_shift_hours" DOUBLE PRECISION;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "shift_1_start" TEXT;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "shift_1_end" TEXT;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "shift_2_start" TEXT;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "shift_2_end" TEXT;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "shift_3_start" TEXT;
ALTER TABLE "tbl_machine" ADD COLUMN IF NOT EXISTS "shift_3_end" TEXT;
ALTER TABLE "tbl_mbomprocess" ADD COLUMN IF NOT EXISTS "dies_id" TEXT;
ALTER TABLE "tbl_mbomprocess" ADD COLUMN IF NOT EXISTS "routing_mode" TEXT NOT NULL DEFAULT 'INHOUSE';
ALTER TABLE "tbl_mbomprocess" ADD COLUMN IF NOT EXISTS "vendor_id" TEXT;
ALTER TABLE "tbl_capacity_machine_override" ALTER COLUMN "machine_id" DROP NOT NULL;
ALTER TABLE "tbl_capacity_machine_override" ADD COLUMN IF NOT EXISTS "routing_mode" TEXT NOT NULL DEFAULT 'INHOUSE';
ALTER TABLE "tbl_capacity_machine_override" ADD COLUMN IF NOT EXISTS "vendor_id" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_mbomprocess_dies_id_idx" ON "tbl_mbomprocess"("dies_id");
CREATE INDEX IF NOT EXISTS "tbl_mbomprocess_vendor_id_idx" ON "tbl_mbomprocess"("vendor_id");
CREATE INDEX IF NOT EXISTS "tbl_mbomprocess_routing_mode_idx" ON "tbl_mbomprocess"("routing_mode");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_vendor_id_idx" ON "tbl_capacity_machine_override"("vendor_id");
DO $$ BEGIN ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_dies_id_fkey" FOREIGN KEY ("dies_id") REFERENCES "tbl_dies"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tbl_capacity_machine_override" ADD CONSTRAINT "tbl_capacity_machine_override_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "tbl_capacity_day_override" (
  "id" TEXT NOT NULL, "plan_id" TEXT NOT NULL, "schedule_date" TIMESTAMP(3) NOT NULL,
  "day_status" TEXT NOT NULL DEFAULT 'WORKING', "shifts_per_day" INTEGER,
  "overtime_start" TEXT, "overtime_end" TEXT, "reason" TEXT, "changed_by" TEXT,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_capacity_day_override_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_capacity_day_override_plan_id_schedule_date_key" ON "tbl_capacity_day_override"("plan_id", "schedule_date");
CREATE INDEX IF NOT EXISTS "tbl_capacity_day_override_plan_id_idx" ON "tbl_capacity_day_override"("plan_id");
CREATE INDEX IF NOT EXISTS "tbl_capacity_day_override_schedule_date_idx" ON "tbl_capacity_day_override"("schedule_date");
DO $$ BEGIN ALTER TABLE "tbl_capacity_day_override" ADD CONSTRAINT "tbl_capacity_day_override_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
