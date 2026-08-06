ALTER TABLE "tbl_machine"
  ADD COLUMN IF NOT EXISTS "machine_family" TEXT,
  ADD COLUMN IF NOT EXISTS "machine_technology" TEXT,
  ADD COLUMN IF NOT EXISTS "machine_specification_code" TEXT,
  ADD COLUMN IF NOT EXISTS "machine_specification_name" TEXT,
  ADD COLUMN IF NOT EXISTS "specification_details" JSONB;

ALTER TABLE "tbl_mbomprocess"
  ADD COLUMN IF NOT EXISTS "machine_specification_code" TEXT;

UPDATE "tbl_machine"
SET
  "machine_family" = COALESCE("machine_family", CASE
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%PRESS%' OR "machine_code" ~* '^P-' THEN 'PRESS'
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%SPOT%' OR "machine_code" ~* '^S-' THEN 'SPOT_WELDING'
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%WELD%' OR "machine_code" ~* '^W-' THEN 'ARC_WELDING'
    WHEN UPPER(COALESCE("machine_type", '')) ~ '(CNC|MACHIN|MILL|LATHE)' THEN 'MACHINING'
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%INSPECT%' THEN 'INSPECTION'
    ELSE 'OTHER'
  END),
  "machine_technology" = COALESCE("machine_technology", CASE
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%PRESS%' OR "machine_code" ~* '^P-' THEN 'MECHANICAL'
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%SPOT%' OR "machine_code" ~* '^S-' THEN 'RESISTANCE'
    WHEN UPPER(COALESCE("machine_type", '')) LIKE '%WELD%' OR "machine_code" ~* '^W-' THEN 'ARC'
    ELSE NULL
  END);

UPDATE "tbl_machine"
SET "machine_specification_code" = COALESCE(
  "machine_specification_code",
  CASE
    WHEN "machine_family" = 'PRESS' AND COALESCE("tonnage", 0) > 0
      THEN 'PRESS-' || COALESCE("machine_technology", 'GENERAL') || '-' || REGEXP_REPLACE("tonnage"::TEXT, '\.0+$', '') || 'T'
    ELSE "machine_family" || '-' || COALESCE(NULLIF("machine_technology", ''), 'UNSPEC')
  END
),
"machine_specification_name" = COALESCE(
  "machine_specification_name",
  CASE
    WHEN "machine_family" = 'PRESS' AND COALESCE("tonnage", 0) > 0
      THEN 'Press ' || INITCAP(LOWER(COALESCE("machine_technology", 'General'))) || ' ' || REGEXP_REPLACE("tonnage"::TEXT, '\.0+$', '') || 'T'
    ELSE INITCAP(REPLACE("machine_family", '_', ' ')) || ' ' || INITCAP(LOWER(COALESCE(NULLIF("machine_technology", ''), 'Unspecified')))
  END
);

UPDATE "tbl_mbomprocess" p
SET "machine_specification_code" = m."machine_specification_code"
FROM "tbl_machine" m
WHERE p."machine_id" = m."id"
  AND p."machine_specification_code" IS NULL;

UPDATE "tbl_mbomprocess"
SET "alternative_machine_ids" = '[]'::JSONB
WHERE "alternative_machine_ids" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "tbl_machine_machine_family_idx"
  ON "tbl_machine"("machine_family");
CREATE INDEX IF NOT EXISTS "tbl_machine_machine_specification_code_idx"
  ON "tbl_machine"("machine_specification_code");
CREATE INDEX IF NOT EXISTS "tbl_mbomprocess_machine_specification_code_idx"
  ON "tbl_mbomprocess"("machine_specification_code");
