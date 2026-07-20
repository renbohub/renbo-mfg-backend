ALTER TABLE "tbl_part"
ADD COLUMN "raw_type" TEXT;

UPDATE "tbl_part"
SET "raw_type" = 'PURCHASE_PART'
WHERE "item_type" = 'RAW';

CREATE INDEX "tbl_part_raw_type_idx" ON "tbl_part"("raw_type");
