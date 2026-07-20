ALTER TABLE "tbl_part"
ADD COLUMN IF NOT EXISTS "item_type" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_part_item_type_idx" ON "tbl_part"("item_type");
