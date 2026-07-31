ALTER TABLE "tbl_production_log"
  ADD COLUMN IF NOT EXISTS "process_code" TEXT,
  ADD COLUMN IF NOT EXISTS "reject_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "attachment_url" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_production_log_process_code_idx"
  ON "tbl_production_log"("process_code");
