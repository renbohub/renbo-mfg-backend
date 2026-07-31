-- Preserve approved/confirmed documents and create a traceable draft version
-- for controlled revisions. These columns are additive for backward compatibility.
ALTER TABLE "tbl_salesorderheader"
  ADD COLUMN IF NOT EXISTS "revision_of_so_number" TEXT,
  ADD COLUMN IF NOT EXISTS "revision_number" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "revision_reason" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_salesorderheader_revision_of_so_number_idx"
  ON "tbl_salesorderheader" ("revision_of_so_number");

ALTER TABLE "tbl_forecast"
  ADD COLUMN IF NOT EXISTS "revision_of_forecast_number" TEXT,
  ADD COLUMN IF NOT EXISTS "revision_number" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "revision_reason" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_forecast_revision_of_forecast_number_idx"
  ON "tbl_forecast" ("revision_of_forecast_number");
