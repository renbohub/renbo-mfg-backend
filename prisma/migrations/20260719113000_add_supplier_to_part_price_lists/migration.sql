ALTER TABLE "tbl_part_pricelist"
  ADD COLUMN IF NOT EXISTS "supplier_id" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_part_pricelist_supplier_id_idx"
  ON "tbl_part_pricelist"("supplier_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tbl_part_pricelist_supplier_id_fkey'
  ) THEN
    ALTER TABLE "tbl_part_pricelist"
      ADD CONSTRAINT "tbl_part_pricelist_supplier_id_fkey"
      FOREIGN KEY ("supplier_id") REFERENCES "tbl_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
