-- Wave 2 additive routing and work-center foundation. Existing MBOM routing remains valid.
ALTER TABLE "tbl_mbomprocess" ADD COLUMN IF NOT EXISTS "routing_operation_id" TEXT;

CREATE TABLE IF NOT EXISTS "tbl_work_center" (
  "id" TEXT PRIMARY KEY, "work_center_code" TEXT NOT NULL UNIQUE, "work_center_name" TEXT NOT NULL,
  "plant_code" TEXT, "line_code" TEXT, "capacity_minutes_per_day" DOUBLE PRECISION,
  "efficiency_percent" DOUBLE PRECISION NOT NULL DEFAULT 100, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "tbl_work_center_machine" (
  "id" TEXT PRIMARY KEY, "work_center_id" TEXT NOT NULL, "machine_id" TEXT NOT NULL, "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_work_center_machine_wc_fkey" FOREIGN KEY ("work_center_id") REFERENCES "tbl_work_center"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_work_center_machine_machine_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_work_center_machine_key" UNIQUE ("work_center_id", "machine_id")
);
CREATE TABLE IF NOT EXISTS "tbl_routing_header" (
  "id" TEXT PRIMARY KEY, "routing_code" TEXT NOT NULL UNIQUE, "part_id" TEXT, "revision" TEXT NOT NULL DEFAULT '1',
  "status" TEXT NOT NULL DEFAULT 'DRAFT', "effective_from" TIMESTAMP(3), "effective_until" TIMESTAMP(3), "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_routing_header_part_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "tbl_routing_operation" (
  "id" TEXT PRIMARY KEY, "routing_header_id" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "process_id" TEXT,
  "work_center_id" TEXT, "setup_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0, "cycle_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "run_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0, "yield_percent" DOUBLE PRECISION NOT NULL DEFAULT 100,
  "is_subcontract" BOOLEAN NOT NULL DEFAULT false, "is_active" BOOLEAN NOT NULL DEFAULT true, "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_routing_operation_header_fkey" FOREIGN KEY ("routing_header_id") REFERENCES "tbl_routing_header"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_routing_operation_process_fkey" FOREIGN KEY ("process_id") REFERENCES "tbl_process"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tbl_routing_operation_wc_fkey" FOREIGN KEY ("work_center_id") REFERENCES "tbl_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tbl_routing_operation_key" UNIQUE ("routing_header_id", "sequence")
);
ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_routing_operation_fkey" FOREIGN KEY ("routing_operation_id") REFERENCES "tbl_routing_operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "tbl_routing_header_part_idx" ON "tbl_routing_header"("part_id");
CREATE INDEX IF NOT EXISTS "tbl_routing_operation_header_idx" ON "tbl_routing_operation"("routing_header_id");
