-- Split material classification into substance, density, grade and form masters.
-- Legacy material columns remain as transaction-safe snapshots and compatibility fields.

CREATE TABLE "tbl_material_substance" (
  "id" TEXT NOT NULL,
  "substance_code" TEXT NOT NULL,
  "substance_name" TEXT NOT NULL,
  "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_substance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_material_density" (
  "id" TEXT NOT NULL,
  "density_code" TEXT NOT NULL,
  "density_name" TEXT,
  "substance_id" TEXT NOT NULL,
  "density_kg_mm3" DOUBLE PRECISION NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_density_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_material_grade" (
  "id" TEXT NOT NULL,
  "grade_code" TEXT NOT NULL,
  "grade_name" TEXT NOT NULL,
  "substance_id" TEXT NOT NULL,
  "thickness" DOUBLE PRECISION,
  "density_id" TEXT,
  "spec" TEXT,
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_grade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_material_form" (
  "id" TEXT NOT NULL,
  "form_code" TEXT NOT NULL,
  "form_name" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "default_purchase_uom_code" TEXT,
  "default_conversion_uom_code" TEXT,
  "default_conversion_factor" DOUBLE PRECISION,
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_form_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_material_substance_substance_code_key" ON "tbl_material_substance"("substance_code");
CREATE INDEX "tbl_material_substance_substance_name_idx" ON "tbl_material_substance"("substance_name");
CREATE INDEX "tbl_material_substance_is_deleted_idx" ON "tbl_material_substance"("is_deleted");
CREATE UNIQUE INDEX "tbl_material_density_density_code_key" ON "tbl_material_density"("density_code");
CREATE INDEX "tbl_material_density_substance_id_idx" ON "tbl_material_density"("substance_id");
CREATE INDEX "tbl_material_density_density_kg_mm3_idx" ON "tbl_material_density"("density_kg_mm3");
CREATE INDEX "tbl_material_density_is_deleted_idx" ON "tbl_material_density"("is_deleted");
CREATE UNIQUE INDEX "tbl_material_grade_grade_code_key" ON "tbl_material_grade"("grade_code");
CREATE INDEX "tbl_material_grade_substance_id_idx" ON "tbl_material_grade"("substance_id");
CREATE INDEX "tbl_material_grade_density_id_idx" ON "tbl_material_grade"("density_id");
CREATE INDEX "tbl_material_grade_thickness_idx" ON "tbl_material_grade"("thickness");
CREATE INDEX "tbl_material_grade_is_deleted_idx" ON "tbl_material_grade"("is_deleted");
CREATE UNIQUE INDEX "tbl_material_form_form_code_key" ON "tbl_material_form"("form_code");
CREATE UNIQUE INDEX "tbl_material_form_symbol_key" ON "tbl_material_form"("symbol");
CREATE INDEX "tbl_material_form_form_name_idx" ON "tbl_material_form"("form_name");
CREATE INDEX "tbl_material_form_is_deleted_idx" ON "tbl_material_form"("is_deleted");

ALTER TABLE "tbl_material"
  ADD COLUMN IF NOT EXISTS "material_substance_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_grade_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_form_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_density_id" TEXT;

ALTER TABLE "tbl_material_pricelist"
  ADD COLUMN IF NOT EXISTS "material_substance_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_grade_id" TEXT;

ALTER TABLE "tbl_mbomdetail"
  ADD COLUMN IF NOT EXISTS "material_form_id" TEXT,
  ADD COLUMN IF NOT EXISTS "material_scheme" TEXT NOT NULL DEFAULT 'DEFAULT',
  ADD COLUMN IF NOT EXISTS "default_gross_weight" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "alternate_material_form_id" TEXT,
  ADD COLUMN IF NOT EXISTS "alternate_material_pitch" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "alternate_material_cavity" INTEGER,
  ADD COLUMN IF NOT EXISTS "alternate_gross_weight" DOUBLE PRECISION;

CREATE INDEX "tbl_material_material_substance_id_idx" ON "tbl_material"("material_substance_id");
CREATE INDEX "tbl_material_material_grade_id_idx" ON "tbl_material"("material_grade_id");
CREATE INDEX "tbl_material_material_form_id_idx" ON "tbl_material"("material_form_id");
CREATE INDEX "tbl_material_material_density_id_idx" ON "tbl_material"("material_density_id");
CREATE INDEX "tbl_material_pricelist_material_substance_id_idx" ON "tbl_material_pricelist"("material_substance_id");
CREATE INDEX "tbl_material_pricelist_material_grade_id_idx" ON "tbl_material_pricelist"("material_grade_id");
CREATE INDEX "tbl_mbomdetail_material_form_id_idx" ON "tbl_mbomdetail"("material_form_id");
CREATE INDEX "tbl_mbomdetail_alternate_material_form_id_idx" ON "tbl_mbomdetail"("alternate_material_form_id");

ALTER TABLE "tbl_material_density" ADD CONSTRAINT "tbl_material_density_substance_id_fkey" FOREIGN KEY ("substance_id") REFERENCES "tbl_material_substance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_material_grade" ADD CONSTRAINT "tbl_material_grade_substance_id_fkey" FOREIGN KEY ("substance_id") REFERENCES "tbl_material_substance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_material_grade" ADD CONSTRAINT "tbl_material_grade_density_id_fkey" FOREIGN KEY ("density_id") REFERENCES "tbl_material_density"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_material" ADD CONSTRAINT "tbl_material_material_substance_id_fkey" FOREIGN KEY ("material_substance_id") REFERENCES "tbl_material_substance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_material" ADD CONSTRAINT "tbl_material_material_grade_id_fkey" FOREIGN KEY ("material_grade_id") REFERENCES "tbl_material_grade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_material" ADD CONSTRAINT "tbl_material_material_form_id_fkey" FOREIGN KEY ("material_form_id") REFERENCES "tbl_material_form"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_material" ADD CONSTRAINT "tbl_material_material_density_id_fkey" FOREIGN KEY ("material_density_id") REFERENCES "tbl_material_density"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_material_pricelist" ADD CONSTRAINT "tbl_material_pricelist_material_substance_id_fkey" FOREIGN KEY ("material_substance_id") REFERENCES "tbl_material_substance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_material_pricelist" ADD CONSTRAINT "tbl_material_pricelist_material_grade_id_fkey" FOREIGN KEY ("material_grade_id") REFERENCES "tbl_material_grade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_mbomdetail" ADD CONSTRAINT "tbl_mbomdetail_material_form_id_fkey" FOREIGN KEY ("material_form_id") REFERENCES "tbl_material_form"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_mbomdetail" ADD CONSTRAINT "tbl_mbomdetail_alternate_material_form_id_fkey" FOREIGN KEY ("alternate_material_form_id") REFERENCES "tbl_material_form"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed common forms and preserve their historic C/S/P notation.
INSERT INTO "tbl_material_form" ("id", "form_code", "form_name", "symbol", "default_purchase_uom_code", "default_conversion_uom_code", "default_conversion_factor", "updated_at")
VALUES
  (gen_random_uuid()::text, 'COIL', 'Coil', 'C', 'COIL', 'KG', NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SHEET', 'Sheet', 'S', 'SHEET', 'KG', NULL, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PIECES', 'Pieces', 'P', 'PCS', 'PCS', 1, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'OTHER', 'Other', 'O', NULL, NULL, NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("form_code") DO NOTHING;

UPDATE "tbl_material" m
SET "material_form_id" = f."id",
    "CSP" = COALESCE(NULLIF(m."CSP", ''), f."symbol")
FROM "tbl_material_form" f
WHERE m."material_form_id" IS NULL
  AND (
    UPPER(COALESCE(m."material_form", '')) = f."form_code"
    OR UPPER(COALESCE(m."CSP", '')) = f."symbol"
  );

UPDATE "tbl_mbomdetail" d
SET "material_form_id" = m."material_form_id"
FROM "tbl_part" p
JOIN "tbl_material" m ON m."id" = p."material_id"
WHERE d."part_id" = p."id"
  AND d."material_form_id" IS NULL;

UPDATE "tbl_mbomdetail"
SET "default_gross_weight" = "gross_weight"
WHERE "default_gross_weight" IS NULL;

UPDATE "tbl_material_pricelist" pl
SET "material_substance_id" = m."material_substance_id",
    "material_grade_id" = m."material_grade_id",
    "thickness" = COALESCE(pl."thickness", m."thickness")
FROM "tbl_material" m
WHERE pl."material_id" = m."id";
