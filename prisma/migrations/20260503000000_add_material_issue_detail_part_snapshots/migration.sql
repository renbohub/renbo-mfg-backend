ALTER TABLE "tbl_material_issue_detail"
  ADD COLUMN "part_number" TEXT,
  ADD COLUMN "part_name" TEXT,
  ADD COLUMN "spec" TEXT,
  ADD COLUMN "thickness" DOUBLE PRECISION,
  ADD COLUMN "width" DOUBLE PRECISION,
  ADD COLUMN "CSP" TEXT;

CREATE INDEX "tbl_material_issue_detail_part_number_idx" ON "tbl_material_issue_detail"("part_number");
CREATE INDEX "tbl_material_issue_detail_part_name_idx" ON "tbl_material_issue_detail"("part_name");
CREATE INDEX "tbl_material_issue_detail_spec_idx" ON "tbl_material_issue_detail"("spec");
CREATE INDEX "tbl_material_issue_detail_thickness_idx" ON "tbl_material_issue_detail"("thickness");
CREATE INDEX "tbl_material_issue_detail_width_idx" ON "tbl_material_issue_detail"("width");
CREATE INDEX "tbl_material_issue_detail_CSP_idx" ON "tbl_material_issue_detail"("CSP");
