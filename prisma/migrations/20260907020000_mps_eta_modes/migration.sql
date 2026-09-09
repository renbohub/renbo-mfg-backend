ALTER TABLE "tbl_mps"
  ADD COLUMN "eta_mode" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "eta_mode_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "eta_mode_changed_by" TEXT,
  ADD COLUMN "eta_mode_changed_at" TIMESTAMP(3),
  ADD COLUMN "eta_mode_history" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "tbl_mps" ADD CONSTRAINT "tbl_mps_eta_mode_check" CHECK ("eta_mode" IN ('BOM', 'MANUAL'));
