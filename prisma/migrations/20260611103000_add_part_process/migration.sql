ALTER TABLE "tbl_part"
ADD COLUMN "process_id" TEXT;

CREATE INDEX "tbl_part_process_id_idx" ON "tbl_part"("process_id");

ALTER TABLE "tbl_part"
ADD CONSTRAINT "tbl_part_process_id_fkey"
FOREIGN KEY ("process_id") REFERENCES "tbl_process"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
