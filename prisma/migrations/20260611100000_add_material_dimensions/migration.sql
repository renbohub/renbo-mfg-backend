ALTER TABLE "tbl_material"
ADD COLUMN "thickness" DOUBLE PRECISION,
ADD COLUMN "width" DOUBLE PRECISION,
ADD COLUMN "CSP" TEXT;

CREATE INDEX "tbl_material_thickness_idx" ON "tbl_material"("thickness");
CREATE INDEX "tbl_material_width_idx" ON "tbl_material"("width");
CREATE INDEX "tbl_material_CSP_idx" ON "tbl_material"("CSP");
