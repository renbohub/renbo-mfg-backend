ALTER TABLE "tbl_production_log"
ADD COLUMN "dps_id" TEXT;

CREATE INDEX "tbl_production_log_dps_id_idx"
ON "tbl_production_log"("dps_id");

ALTER TABLE "tbl_production_log"
ADD CONSTRAINT "tbl_production_log_dps_id_fkey"
FOREIGN KEY ("dps_id") REFERENCES "tbl_daily_production_schedule"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
