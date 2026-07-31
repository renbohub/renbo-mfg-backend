ALTER TABLE "tbl_forecast"
  ADD COLUMN IF NOT EXISTS "demand_bucket" TEXT NOT NULL DEFAULT 'PLANNING',
  ADD COLUMN IF NOT EXISTS "version_group" TEXT,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "is_current_version" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "source_batch_number" TEXT;

ALTER TABLE "tbl_forecast_detail"
  ADD COLUMN IF NOT EXISTS "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "tbl_forecast_demand_bucket_idx" ON "tbl_forecast"("demand_bucket");
CREATE INDEX IF NOT EXISTS "tbl_forecast_version_group_version_idx" ON "tbl_forecast"("version_group", "version");
CREATE INDEX IF NOT EXISTS "tbl_forecast_is_current_version_idx" ON "tbl_forecast"("is_current_version");
