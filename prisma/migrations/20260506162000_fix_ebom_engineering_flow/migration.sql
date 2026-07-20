-- Strengthen EBOM as an engineering structure:
-- - allow real parent/child component trees
-- - keep engineering lead-time estimates on EBOM detail

ALTER TABLE "tbl_ebomdetail"
ADD COLUMN IF NOT EXISTS "parent_detail_id" TEXT,
ADD COLUMN IF NOT EXISTS "lead_time" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tbl_ebomdetail_parent_detail_id_fkey'
  ) THEN
    ALTER TABLE "tbl_ebomdetail"
    ADD CONSTRAINT "tbl_ebomdetail_parent_detail_id_fkey"
    FOREIGN KEY ("parent_detail_id")
    REFERENCES "tbl_ebomdetail"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tbl_ebomdetail_parent_detail_id_idx"
ON "tbl_ebomdetail"("parent_detail_id");

CREATE INDEX IF NOT EXISTS "tbl_ebomdetail_level_component_idx"
ON "tbl_ebomdetail"("level_component");
