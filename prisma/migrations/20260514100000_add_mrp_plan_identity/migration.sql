ALTER TABLE "tbl_mrp_run"
ADD COLUMN IF NOT EXISTS "plan_number" TEXT,
ADD COLUMN IF NOT EXISTS "plan_revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "plan_scope" TEXT,
ADD COLUMN IF NOT EXISTS "is_current_plan" BOOLEAN NOT NULL DEFAULT true;

WITH normalized AS (
  SELECT
    "id",
    CASE
      WHEN "mps_number" IS NOT NULL AND "mps_number" <> '' THEN 'MRP-' || "mps_number"
      WHEN "run_number" LIKE 'MRP-SO-%' THEN REPLACE("run_number", 'MRP-SO-', 'MRP-SO-')
      WHEN "run_number" LIKE 'MRP-SO%' THEN "run_number"
      ELSE COALESCE("run_number", "id")
    END AS resolved_plan_number,
    CASE
      WHEN "mps_number" IS NOT NULL AND "mps_number" <> '' THEN 'MPS'
      WHEN "run_number" LIKE 'MRP-SO%' THEN 'SO'
      ELSE 'Manual'
    END AS resolved_plan_scope
  FROM "tbl_mrp_run"
),
numbered AS (
  SELECT
    r."id",
    n.resolved_plan_number,
    n.resolved_plan_scope,
    ROW_NUMBER() OVER (
      PARTITION BY n.resolved_plan_number
      ORDER BY r."run_date" ASC, r."created_at" ASC, r."run_number" ASC
    ) AS resolved_revision,
    ROW_NUMBER() OVER (
      PARTITION BY n.resolved_plan_number
      ORDER BY
        CASE WHEN r."is_deleted" = false THEN 0 ELSE 1 END ASC,
        r."run_date" DESC,
        r."created_at" DESC,
        r."run_number" DESC
    ) AS current_rank
  FROM "tbl_mrp_run" r
  JOIN normalized n ON n."id" = r."id"
)
UPDATE "tbl_mrp_run" r
SET
  "plan_number" = COALESCE(r."plan_number", numbered.resolved_plan_number),
  "plan_scope" = COALESCE(r."plan_scope", numbered.resolved_plan_scope),
  "plan_revision" = numbered.resolved_revision,
  "is_current_plan" = numbered.current_rank = 1
FROM numbered
WHERE numbered."id" = r."id";

CREATE INDEX IF NOT EXISTS "tbl_mrp_run_plan_number_idx" ON "tbl_mrp_run"("plan_number");
CREATE INDEX IF NOT EXISTS "tbl_mrp_run_plan_number_plan_revision_idx" ON "tbl_mrp_run"("plan_number", "plan_revision");
CREATE INDEX IF NOT EXISTS "tbl_mrp_run_is_current_plan_idx" ON "tbl_mrp_run"("is_current_plan");
