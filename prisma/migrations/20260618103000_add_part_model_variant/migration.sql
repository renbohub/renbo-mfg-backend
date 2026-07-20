ALTER TABLE "tbl_part"
ADD COLUMN "model" TEXT,
ADD COLUMN "variant" TEXT;

CREATE INDEX "tbl_part_model_idx"
ON "tbl_part"("model");

CREATE INDEX "tbl_part_variant_idx"
ON "tbl_part"("variant");
