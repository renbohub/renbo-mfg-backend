-- Default routing tetap berada di tbl_mbomprocess.machine_id.
-- Kolom ini hanya menyimpan daftar mesin alternatif yang secara eksplisit
-- diizinkan oleh engineering untuk dipilih PPIC saat capacity penuh.
ALTER TABLE "tbl_mbomprocess"
  ADD COLUMN IF NOT EXISTS "alternative_machine_ids" JSONB;

CREATE TABLE IF NOT EXISTS "tbl_capacity_machine_override" (
  "id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "line_number" INTEGER NOT NULL,
  "mbom_process_id" TEXT NOT NULL,
  "machine_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "changed_by" TEXT,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_capacity_machine_override_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tbl_capacity_machine_override_plan_id_line_number_mbom_process_id_key"
  ON "tbl_capacity_machine_override"("plan_id", "line_number", "mbom_process_id");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_plan_id_idx"
  ON "tbl_capacity_machine_override"("plan_id");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_mbom_process_id_idx"
  ON "tbl_capacity_machine_override"("mbom_process_id");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_machine_id_idx"
  ON "tbl_capacity_machine_override"("machine_id");
CREATE INDEX IF NOT EXISTS "tbl_capacity_machine_override_is_deleted_idx"
  ON "tbl_capacity_machine_override"("is_deleted");

DO $$ BEGIN
  ALTER TABLE "tbl_capacity_machine_override"
    ADD CONSTRAINT "tbl_capacity_machine_override_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "tbl_capacity_machine_override"
    ADD CONSTRAINT "tbl_capacity_machine_override_mbom_process_id_fkey"
    FOREIGN KEY ("mbom_process_id") REFERENCES "tbl_mbomprocess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "tbl_capacity_machine_override"
    ADD CONSTRAINT "tbl_capacity_machine_override_machine_id_fkey"
    FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
