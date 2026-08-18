ALTER TABLE "tbl_production_log"
  ADD COLUMN "quality_check_mode" TEXT NOT NULL DEFAULT 'SEPARATE_QC',
  ADD COLUMN "self_check_notes" TEXT,
  ADD COLUMN "self_checked_by" TEXT,
  ADD COLUMN "self_checked_at" TIMESTAMP(3);
