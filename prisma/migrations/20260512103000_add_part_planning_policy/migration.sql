ALTER TABLE "tbl_part"
ADD COLUMN IF NOT EXISTS "planning_policy" TEXT NOT NULL DEFAULT 'MTO';

ALTER TABLE "tbl_part"
ALTER COLUMN "planning_policy" SET DEFAULT 'MTO';

UPDATE "tbl_part"
SET "planning_policy" = 'MTO'
WHERE "planning_policy" IS NULL
   OR "planning_policy" = 'MTS';
