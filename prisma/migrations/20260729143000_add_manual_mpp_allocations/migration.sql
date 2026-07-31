CREATE TABLE "tbl_production_plan_allocation" (
  "id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "line_number" INTEGER NOT NULL,
  "mbom_process_id" TEXT NOT NULL,
  "schedule_date" TIMESTAMP(3) NOT NULL,
  "shift" TEXT NOT NULL,
  "machine_id" TEXT,
  "routing_mode" TEXT NOT NULL DEFAULT 'INHOUSE',
  "vendor_id" TEXT,
  "planned_qty" DOUBLE PRECISION NOT NULL,
  "uom_code" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "notes" TEXT,
  "published_at" TIMESTAMP(3),
  "published_by" TEXT,
  "created_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_production_plan_allocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_production_plan_allocation_plan_id_line_number_idx" ON "tbl_production_plan_allocation"("plan_id", "line_number");
CREATE INDEX "tbl_production_plan_allocation_mbom_process_id_idx" ON "tbl_production_plan_allocation"("mbom_process_id");
CREATE INDEX "tbl_production_plan_allocation_schedule_date_idx" ON "tbl_production_plan_allocation"("schedule_date");
CREATE INDEX "tbl_production_plan_allocation_machine_id_idx" ON "tbl_production_plan_allocation"("machine_id");
CREATE INDEX "tbl_production_plan_allocation_vendor_id_idx" ON "tbl_production_plan_allocation"("vendor_id");
CREATE INDEX "tbl_production_plan_allocation_status_idx" ON "tbl_production_plan_allocation"("status");
CREATE INDEX "tbl_production_plan_allocation_is_deleted_idx" ON "tbl_production_plan_allocation"("is_deleted");

ALTER TABLE "tbl_production_plan_allocation" ADD CONSTRAINT "tbl_production_plan_allocation_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_production_plan_allocation" ADD CONSTRAINT "tbl_production_plan_allocation_mbom_process_id_fkey" FOREIGN KEY ("mbom_process_id") REFERENCES "tbl_mbomprocess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_production_plan_allocation" ADD CONSTRAINT "tbl_production_plan_allocation_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_production_plan_allocation" ADD CONSTRAINT "tbl_production_plan_allocation_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "tbl_vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
