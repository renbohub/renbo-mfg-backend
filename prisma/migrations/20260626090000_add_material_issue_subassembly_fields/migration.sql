ALTER TABLE "tbl_material_issue_detail"
ADD COLUMN IF NOT EXISTS "requirement_source" TEXT,
ADD COLUMN IF NOT EXISTS "is_sub_assembly" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "tbl_material_issue_detail_requirement_source_idx"
ON "tbl_material_issue_detail"("requirement_source");

CREATE INDEX IF NOT EXISTS "tbl_material_issue_detail_is_sub_assembly_idx"
ON "tbl_material_issue_detail"("is_sub_assembly");