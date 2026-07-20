ALTER TABLE "tbl_mbomdetail"
  ADD COLUMN "material_thickness" DOUBLE PRECISION,
  ADD COLUMN "material_width" DOUBLE PRECISION,
  ADD COLUMN "material_pitch" DOUBLE PRECISION,
  ADD COLUMN "material_cavity" INTEGER,
  ADD COLUMN "material_density" DOUBLE PRECISION,
  ADD COLUMN "gross_weight" DOUBLE PRECISION NOT NULL DEFAULT 0;
