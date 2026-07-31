CREATE TABLE "tbl_mps_delivery_plan" (
  "id" TEXT NOT NULL,
  "mps_number" TEXT NOT NULL,
  "mps_detail_id" TEXT,
  "phase_number" INTEGER NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_code" TEXT NOT NULL,
  "target_name" TEXT,
  "part_code" TEXT NOT NULL,
  "planned_date" TIMESTAMP(3) NOT NULL,
  "qty_planned" DOUBLE PRECISION NOT NULL,
  "uom_code" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Planned',
  "notes" TEXT,
  "created_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_mps_delivery_plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_mps_delivery_plan_mps_number_phase_number_key" ON "tbl_mps_delivery_plan"("mps_number", "phase_number");
CREATE INDEX "tbl_mps_delivery_plan_mps_detail_id_idx" ON "tbl_mps_delivery_plan"("mps_detail_id");
CREATE INDEX "tbl_mps_delivery_plan_planned_date_idx" ON "tbl_mps_delivery_plan"("planned_date");
CREATE INDEX "tbl_mps_delivery_plan_target_type_target_code_idx" ON "tbl_mps_delivery_plan"("target_type", "target_code");
CREATE INDEX "tbl_mps_delivery_plan_is_deleted_idx" ON "tbl_mps_delivery_plan"("is_deleted");
ALTER TABLE "tbl_mps_delivery_plan" ADD CONSTRAINT "tbl_mps_delivery_plan_mps_number_fkey" FOREIGN KEY ("mps_number") REFERENCES "tbl_mps"("mps_number") ON DELETE CASCADE ON UPDATE CASCADE;
