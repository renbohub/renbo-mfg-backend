-- Convert legacy material rows into the normalized masters without deleting
-- or rewriting the legacy snapshot columns.

WITH legacy_substances AS (
  SELECT
    regexp_replace(UPPER(TRIM("material_type")), '[^A-Z0-9]+', '_', 'g') AS code,
    MIN(TRIM("material_type")) AS name
  FROM "tbl_material"
  WHERE NULLIF(TRIM(COALESCE("material_type", '')), '') IS NOT NULL
  GROUP BY regexp_replace(UPPER(TRIM("material_type")), '[^A-Z0-9]+', '_', 'g')
)
INSERT INTO "tbl_material_substance"
  ("id", "substance_code", "substance_name", "description", "updated_at")
SELECT
  gen_random_uuid()::text,
  code,
  name,
  'Backfill dari legacy Master Material',
  CURRENT_TIMESTAMP
FROM legacy_substances
WHERE code <> ''
ON CONFLICT ("substance_code") DO NOTHING;

WITH density_rows AS (
  SELECT DISTINCT
    s."id" AS substance_id,
    s."substance_code",
    m."density"
  FROM "tbl_material" m
  JOIN "tbl_material_substance" s
    ON s."substance_code" = regexp_replace(UPPER(TRIM(m."material_type")), '[^A-Z0-9]+', '_', 'g')
  WHERE m."density" IS NOT NULL AND m."density" > 0
),
numbered AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY substance_id ORDER BY density) AS density_number
  FROM density_rows
)
INSERT INTO "tbl_material_density"
  ("id", "density_code", "density_name", "substance_id", "density_kg_mm3", "is_default", "notes", "updated_at")
SELECT
  gen_random_uuid()::text,
  LEFT(substance_code || '-D' || density_number, 100),
  substance_code || ' ' || density::text,
  substance_id,
  density,
  density_number = 1,
  'Backfill dari legacy Master Material',
  CURRENT_TIMESTAMP
FROM numbered n
WHERE NOT EXISTS (
  SELECT 1
  FROM "tbl_material_density" d
  WHERE d."substance_id" = n.substance_id
    AND d."density_kg_mm3" = n.density
);

WITH legacy_grades AS (
  SELECT DISTINCT ON (
    s."id",
    UPPER(TRIM(COALESCE(NULLIF(m."material_grade", ''), NULLIF(m."spec", ''), 'LEGACY'))),
    m."thickness"
  )
    s."id" AS substance_id,
    UPPER(TRIM(COALESCE(NULLIF(m."material_grade", ''), NULLIF(m."spec", ''), 'LEGACY'))) AS grade_code,
    TRIM(COALESCE(NULLIF(m."material_grade", ''), NULLIF(m."spec", ''), 'Legacy')) AS grade_name,
    m."thickness",
    m."spec",
    d."id" AS density_id
  FROM "tbl_material" m
  JOIN "tbl_material_substance" s
    ON s."substance_code" = regexp_replace(UPPER(TRIM(m."material_type")), '[^A-Z0-9]+', '_', 'g')
  LEFT JOIN "tbl_material_density" d
    ON d."substance_id" = s."id"
   AND d."density_kg_mm3" = m."density"
  ORDER BY
    s."id",
    UPPER(TRIM(COALESCE(NULLIF(m."material_grade", ''), NULLIF(m."spec", ''), 'LEGACY'))),
    m."thickness",
    m."updated_at" DESC
)
INSERT INTO "tbl_material_grade"
  ("id", "grade_code", "grade_name", "substance_id", "thickness", "density_id", "spec", "notes", "updated_at")
SELECT
  gen_random_uuid()::text,
  grade_code,
  grade_name,
  substance_id,
  thickness,
  density_id,
  spec,
  'Backfill dari legacy Master Material',
  CURRENT_TIMESTAMP
FROM legacy_grades g
WHERE NOT EXISTS (
  SELECT 1
  FROM "tbl_material_grade" existing
  WHERE existing."substance_id" = g.substance_id
    AND existing."grade_code" = g.grade_code
    AND existing."thickness" IS NOT DISTINCT FROM g.thickness
);

UPDATE "tbl_material" m
SET "material_substance_id" = s."id"
FROM "tbl_material_substance" s
WHERE s."substance_code" = regexp_replace(UPPER(TRIM(m."material_type")), '[^A-Z0-9]+', '_', 'g')
  AND m."material_substance_id" IS NULL;

UPDATE "tbl_material" m
SET "material_density_id" = d."id"
FROM "tbl_material_density" d
WHERE d."substance_id" = m."material_substance_id"
  AND d."density_kg_mm3" = m."density"
  AND m."material_density_id" IS NULL;

UPDATE "tbl_material" m
SET "material_grade_id" = g."id"
FROM "tbl_material_grade" g
WHERE g."substance_id" = m."material_substance_id"
  AND g."grade_code" = UPPER(TRIM(COALESCE(NULLIF(m."material_grade", ''), NULLIF(m."spec", ''), 'LEGACY')))
  AND g."thickness" IS NOT DISTINCT FROM m."thickness"
  AND m."material_grade_id" IS NULL;

UPDATE "tbl_material_pricelist" pl
SET
  "material_substance_id" = m."material_substance_id",
  "material_grade_id" = m."material_grade_id",
  "thickness" = COALESCE(pl."thickness", m."thickness")
FROM "tbl_material" m
WHERE pl."material_id" = m."id"
  AND (
    pl."material_substance_id" IS NULL
    OR pl."material_grade_id" IS NULL
    OR pl."thickness" IS NULL
  );
