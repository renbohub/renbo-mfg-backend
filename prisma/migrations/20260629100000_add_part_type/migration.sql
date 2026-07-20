ALTER TABLE "tbl_part"
ADD COLUMN "part_type" TEXT NOT NULL DEFAULT 'STANDARD';

CREATE INDEX "tbl_part_part_type_idx" ON "tbl_part"("part_type");
