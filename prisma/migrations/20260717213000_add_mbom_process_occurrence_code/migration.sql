ALTER TABLE "tbl_mbomprocess"
  ADD COLUMN IF NOT EXISTS "occurrence_code" TEXT;

WITH ranked AS (
  SELECT mp."id", p."process_code",
         COUNT(*) OVER (PARTITION BY mp."no_reg", mp."process_id") AS usage_count,
         ROW_NUMBER() OVER (PARTITION BY mp."no_reg", mp."process_id" ORDER BY mp."sequence", mp."created_at", mp."id") AS usage_number
  FROM "tbl_mbomprocess" mp
  JOIN "tbl_process" p ON p."id" = mp."process_id"
  WHERE mp."is_deleted" = false
), numbered AS (
  SELECT "id", CASE WHEN usage_count = 1 THEN "process_code" ELSE "process_code" || '-' || usage_number::TEXT END AS occurrence_code
  FROM ranked
)
UPDATE "tbl_mbomprocess" mp
SET "occurrence_code" = numbered.occurrence_code,
    "notes" = COALESCE(mp."notes", numbered.occurrence_code),
    "updated_at" = CURRENT_TIMESTAMP
FROM numbered
WHERE mp."id" = numbered."id";

CREATE INDEX IF NOT EXISTS "tbl_mbomprocess_occurrence_code_idx" ON "tbl_mbomprocess"("occurrence_code");
