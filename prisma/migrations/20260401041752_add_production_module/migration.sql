-- CreateTable
CREATE TABLE "tbl_production_log" (
    "id" TEXT NOT NULL,
    "log_number" TEXT NOT NULL,
    "log_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mo_id" TEXT NOT NULL,
    "wo_id" TEXT,
    "shift" TEXT NOT NULL,
    "machine_code" TEXT,
    "operator_name" TEXT NOT NULL,
    "qty_planned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_produced" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_good" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_rework" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "downtime" DOUBLE PRECISION,
    "downtime_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_production_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_quality_inspection" (
    "id" TEXT NOT NULL,
    "inspection_number" TEXT NOT NULL,
    "inspection_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mo_id" TEXT NOT NULL,
    "wo_id" TEXT,
    "production_log_id" TEXT,
    "part_id" TEXT,
    "batch_number" TEXT,
    "sample_size" INTEGER NOT NULL DEFAULT 1,
    "qty_inspected" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_passed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_failed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_rework" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL DEFAULT 'Pending',
    "inspected_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_quality_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_quality_inspection_detail" (
    "id" TEXT NOT NULL,
    "inspection_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "parameter_name" TEXT NOT NULL,
    "standard" TEXT,
    "actual_value" TEXT,
    "unit" TEXT,
    "is_pass" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_quality_inspection_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_material_issue" (
    "id" TEXT NOT NULL,
    "issue_number" TEXT NOT NULL,
    "issue_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mo_id" TEXT NOT NULL,
    "warehouse_code" TEXT NOT NULL,
    "issued_by" TEXT,
    "received_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_material_issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_material_issue_detail" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "part_code" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "qty_required" DOUBLE PRECISION NOT NULL,
    "qty_issued" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_returned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "lot_number" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_material_issue_detail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_production_log_log_number_key" ON "tbl_production_log"("log_number");

-- CreateIndex
CREATE INDEX "tbl_production_log_log_number_idx" ON "tbl_production_log"("log_number");

-- CreateIndex
CREATE INDEX "tbl_production_log_mo_id_idx" ON "tbl_production_log"("mo_id");

-- CreateIndex
CREATE INDEX "tbl_production_log_wo_id_idx" ON "tbl_production_log"("wo_id");

-- CreateIndex
CREATE INDEX "tbl_production_log_log_date_idx" ON "tbl_production_log"("log_date");

-- CreateIndex
CREATE INDEX "tbl_production_log_shift_idx" ON "tbl_production_log"("shift");

-- CreateIndex
CREATE INDEX "tbl_production_log_machine_code_idx" ON "tbl_production_log"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_production_log_status_idx" ON "tbl_production_log"("status");

-- CreateIndex
CREATE INDEX "tbl_production_log_is_deleted_idx" ON "tbl_production_log"("is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_quality_inspection_inspection_number_key" ON "tbl_quality_inspection"("inspection_number");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_inspection_number_idx" ON "tbl_quality_inspection"("inspection_number");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_mo_id_idx" ON "tbl_quality_inspection"("mo_id");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_wo_id_idx" ON "tbl_quality_inspection"("wo_id");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_production_log_id_idx" ON "tbl_quality_inspection"("production_log_id");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_part_id_idx" ON "tbl_quality_inspection"("part_id");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_decision_idx" ON "tbl_quality_inspection"("decision");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_status_idx" ON "tbl_quality_inspection"("status");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_is_deleted_idx" ON "tbl_quality_inspection"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_detail_inspection_id_idx" ON "tbl_quality_inspection_detail"("inspection_id");

-- CreateIndex
CREATE INDEX "tbl_quality_inspection_detail_is_pass_idx" ON "tbl_quality_inspection_detail"("is_pass");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_material_issue_issue_number_key" ON "tbl_material_issue"("issue_number");

-- CreateIndex
CREATE INDEX "tbl_material_issue_issue_number_idx" ON "tbl_material_issue"("issue_number");

-- CreateIndex
CREATE INDEX "tbl_material_issue_mo_id_idx" ON "tbl_material_issue"("mo_id");

-- CreateIndex
CREATE INDEX "tbl_material_issue_warehouse_code_idx" ON "tbl_material_issue"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_material_issue_status_idx" ON "tbl_material_issue"("status");

-- CreateIndex
CREATE INDEX "tbl_material_issue_is_deleted_idx" ON "tbl_material_issue"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_material_issue_detail_issue_id_idx" ON "tbl_material_issue_detail"("issue_id");

-- CreateIndex
CREATE INDEX "tbl_material_issue_detail_part_code_idx" ON "tbl_material_issue_detail"("part_code");

-- CreateIndex
CREATE INDEX "tbl_material_issue_detail_product_id_idx" ON "tbl_material_issue_detail"("product_id");

-- CreateIndex
CREATE INDEX "tbl_material_issue_detail_lot_number_idx" ON "tbl_material_issue_detail"("lot_number");

-- CreateIndex
CREATE INDEX "tbl_material_issue_detail_is_deleted_idx" ON "tbl_material_issue_detail"("is_deleted");

-- AddForeignKey
ALTER TABLE "tbl_production_log" ADD CONSTRAINT "tbl_production_log_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "tbl_manufacturing_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_production_log" ADD CONSTRAINT "tbl_production_log_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "tbl_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quality_inspection" ADD CONSTRAINT "tbl_quality_inspection_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "tbl_manufacturing_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quality_inspection" ADD CONSTRAINT "tbl_quality_inspection_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "tbl_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quality_inspection" ADD CONSTRAINT "tbl_quality_inspection_production_log_id_fkey" FOREIGN KEY ("production_log_id") REFERENCES "tbl_production_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quality_inspection" ADD CONSTRAINT "tbl_quality_inspection_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "tbl_part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_quality_inspection_detail" ADD CONSTRAINT "tbl_quality_inspection_detail_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "tbl_quality_inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_issue" ADD CONSTRAINT "tbl_material_issue_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "tbl_manufacturing_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_issue" ADD CONSTRAINT "tbl_material_issue_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_issue_detail" ADD CONSTRAINT "tbl_material_issue_detail_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "tbl_material_issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_material_issue_detail" ADD CONSTRAINT "tbl_material_issue_detail_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
