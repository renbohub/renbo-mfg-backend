ALTER TABLE "tbl_material_issue"
ADD COLUMN "wo_id" TEXT;

CREATE INDEX "tbl_material_issue_wo_id_idx" ON "tbl_material_issue"("wo_id");

ALTER TABLE "tbl_material_issue"
ADD CONSTRAINT "tbl_material_issue_wo_id_fkey"
FOREIGN KEY ("wo_id") REFERENCES "tbl_work_order"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
