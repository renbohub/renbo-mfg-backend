-- AlterTable: tambah kolom uom_code di tbl_product_pricelist
ALTER TABLE "tbl_product_pricelist" ADD COLUMN IF NOT EXISTS "uom_code" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tbl_product_pricelist_uom_code_idx" ON "tbl_product_pricelist"("uom_code");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tbl_product_pricelist_uom_code_fkey'
  ) THEN
    ALTER TABLE "tbl_product_pricelist" ADD CONSTRAINT "tbl_product_pricelist_uom_code_fkey"
      FOREIGN KEY ("uom_code") REFERENCES "tbl_uom"("uom_code")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
