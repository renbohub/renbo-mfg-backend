ALTER TABLE "tbl_monthly_production_plan"
  ADD COLUMN IF NOT EXISTS "capacity_override_approved" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "capacity_override_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "capacity_override_by" TEXT,
  ADD COLUMN IF NOT EXISTS "capacity_override_at" TIMESTAMP(3);
