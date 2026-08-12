-- Additive BOM revision traceability. Existing historical rows remain valid.
ALTER TABLE "tbl_mbomheader"
  ADD COLUMN IF NOT EXISTS "revision_of_mbom_id" TEXT,
  ADD COLUMN IF NOT EXISTS "revision_note" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_mbomheader_revision_of_mbom_id_idx"
  ON "tbl_mbomheader"("revision_of_mbom_id");

ALTER TABLE "tbl_mps_detail"
  ADD COLUMN IF NOT EXISTS "mbom_selection_mode" TEXT NOT NULL DEFAULT 'AUTO_EFFECTIVE_DATE',
  ADD COLUMN IF NOT EXISTS "mbom_selection_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mbom_revision_snapshot" INTEGER,
  ADD COLUMN IF NOT EXISTS "mbom_no_reg_snapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "mbom_selection_warning" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_mps_detail_mbom_selection_date_idx"
  ON "tbl_mps_detail"("mbom_selection_date");
