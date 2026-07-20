-- CreateTable
CREATE TABLE "tbl_downtime_log" (
    "id" TEXT NOT NULL,
    "downtime_number" TEXT NOT NULL,
    "downtime_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mo_id" TEXT NOT NULL,
    "wo_id" TEXT,
    "production_log_id" TEXT,
    "shift" TEXT,
    "machine_code" TEXT,
    "operator_name" TEXT,
    "start_time" TIMESTAMP(3),
    "end_time" TIMESTAMP(3),
    "duration_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_downtime_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_downtime_log_downtime_number_key" ON "tbl_downtime_log"("downtime_number");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_downtime_number_idx" ON "tbl_downtime_log"("downtime_number");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_downtime_date_idx" ON "tbl_downtime_log"("downtime_date");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_mo_id_idx" ON "tbl_downtime_log"("mo_id");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_wo_id_idx" ON "tbl_downtime_log"("wo_id");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_production_log_id_idx" ON "tbl_downtime_log"("production_log_id");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_shift_idx" ON "tbl_downtime_log"("shift");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_machine_code_idx" ON "tbl_downtime_log"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_status_idx" ON "tbl_downtime_log"("status");

-- CreateIndex
CREATE INDEX "tbl_downtime_log_is_deleted_idx" ON "tbl_downtime_log"("is_deleted");

-- AddForeignKey
ALTER TABLE "tbl_downtime_log" ADD CONSTRAINT "tbl_downtime_log_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "tbl_manufacturing_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_downtime_log" ADD CONSTRAINT "tbl_downtime_log_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "tbl_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_downtime_log" ADD CONSTRAINT "tbl_downtime_log_production_log_id_fkey" FOREIGN KEY ("production_log_id") REFERENCES "tbl_production_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;
