-- Explicit SO-to-Forecast delivery phase pegging. This is additive: Marketing's
-- Forecast and SO delivery targets remain separate and historical rows stay intact.
ALTER TABLE "tbl_demand_delivery_target"
  ADD COLUMN IF NOT EXISTS "consumes_forecast_target_id" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_demand_delivery_target_consumes_forecast_target_id_idx"
  ON "tbl_demand_delivery_target"("consumes_forecast_target_id");
