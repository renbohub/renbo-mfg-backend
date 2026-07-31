-- Legacy rows without a recognizable Coil/Sheet/Pieces marker stay usable
-- through an explicit OTHER form instead of a null lookup.
UPDATE "tbl_material" m
SET
  "material_form_id" = f."id",
  "material_form" = COALESCE(NULLIF(m."material_form", ''), f."form_code"),
  "CSP" = COALESCE(NULLIF(m."CSP", ''), f."symbol")
FROM "tbl_material_form" f
WHERE f."form_code" = 'OTHER'
  AND m."material_form_id" IS NULL;
