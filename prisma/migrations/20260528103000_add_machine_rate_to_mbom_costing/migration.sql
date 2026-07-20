-- Add machine costing rate master data and snapshot machine rates into MBOM costing.
ALTER TABLE "tbl_machine"
  ADD COLUMN IF NOT EXISTS "costing_rate" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "costing_rate_type" TEXT DEFAULT 'PER_HOUR';

ALTER TABLE "tbl_mbomprocess"
  ADD COLUMN IF NOT EXISTS "machine_id" TEXT;

ALTER TABLE "tbl_mbomcost_detail"
  ADD COLUMN IF NOT EXISTS "machine_id" TEXT,
  ADD COLUMN IF NOT EXISTS "machine_code_snapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "machine_name_snapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "machine_rate_type_snapshot" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_mbomprocess_machine_id_idx" ON "tbl_mbomprocess"("machine_id");
CREATE INDEX IF NOT EXISTS "tbl_mbomcost_detail_machine_id_idx" ON "tbl_mbomcost_detail"("machine_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'tbl_mbomprocess_machine_id_fkey'
  ) THEN
    ALTER TABLE "tbl_mbomprocess"
      ADD CONSTRAINT "tbl_mbomprocess_machine_id_fkey"
      FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
