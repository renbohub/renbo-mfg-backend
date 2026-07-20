-- Add assembly/sub-assembly policy controls.
ALTER TABLE "tbl_part"
ADD COLUMN IF NOT EXISTS "assembly_policy" TEXT NOT NULL DEFAULT 'INLINE';

ALTER TABLE "tbl_mbomdetail"
ADD COLUMN IF NOT EXISTS "assembly_policy_override" TEXT NOT NULL DEFAULT 'DEFAULT';

CREATE INDEX IF NOT EXISTS "tbl_part_assembly_policy_idx" ON "tbl_part"("assembly_policy");
CREATE INDEX IF NOT EXISTS "tbl_mbomdetail_assembly_policy_override_idx" ON "tbl_mbomdetail"("assembly_policy_override");
