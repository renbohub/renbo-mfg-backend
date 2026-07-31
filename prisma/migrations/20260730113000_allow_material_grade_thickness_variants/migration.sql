-- The same commercial grade can exist at several thicknesses.
DROP INDEX IF EXISTS "tbl_material_grade_grade_code_key";
CREATE UNIQUE INDEX "tbl_material_grade_substance_id_grade_code_thickness_key"
  ON "tbl_material_grade"("substance_id", "grade_code", "thickness");
