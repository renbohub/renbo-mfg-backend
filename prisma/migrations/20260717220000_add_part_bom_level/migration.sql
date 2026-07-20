ALTER TABLE "tbl_part"
  ADD COLUMN IF NOT EXISTS "bom_level" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "tbl_part_bom_level_idx" ON "tbl_part"("bom_level");
