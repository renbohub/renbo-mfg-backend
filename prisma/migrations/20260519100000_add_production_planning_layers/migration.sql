CREATE TABLE "tbl_monthly_production_plan" (
    "id" TEXT NOT NULL,
    "plan_number" TEXT NOT NULL,
    "plan_month" TIMESTAMP(3) NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "source_type" TEXT NOT NULL DEFAULT 'PlannedOrder',
    "notes" TEXT,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "released_by" TEXT,
    "released_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_monthly_production_plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_monthly_production_plan_detail" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "planned_order_number" TEXT,
    "manufacturing_order_number" TEXT,
    "part_code" TEXT NOT NULL,
    "part_id" TEXT,
    "qty_planned" DOUBLE PRECISION NOT NULL,
    "qty_released" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "required_date" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'Planned',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_monthly_production_plan_detail_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_daily_production_schedule" (
    "id" TEXT NOT NULL,
    "schedule_number" TEXT NOT NULL,
    "schedule_date" TIMESTAMP(3) NOT NULL,
    "shift" TEXT NOT NULL,
    "mo_id" TEXT,
    "mo_number" TEXT,
    "wo_id" TEXT,
    "wo_number" TEXT,
    "part_id" TEXT,
    "part_code" TEXT,
    "process_id" TEXT,
    "machine_id" TEXT,
    "planned_qty" DOUBLE PRECISION NOT NULL,
    "actual_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uom_code" TEXT,
    "operator_name" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_daily_production_schedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_monthly_production_plan_plan_number_key" ON "tbl_monthly_production_plan"("plan_number");
CREATE INDEX "tbl_monthly_production_plan_plan_number_idx" ON "tbl_monthly_production_plan"("plan_number");
CREATE INDEX "tbl_monthly_production_plan_plan_month_idx" ON "tbl_monthly_production_plan"("plan_month");
CREATE INDEX "tbl_monthly_production_plan_period_start_idx" ON "tbl_monthly_production_plan"("period_start");
CREATE INDEX "tbl_monthly_production_plan_period_end_idx" ON "tbl_monthly_production_plan"("period_end");
CREATE INDEX "tbl_monthly_production_plan_status_idx" ON "tbl_monthly_production_plan"("status");
CREATE INDEX "tbl_monthly_production_plan_is_deleted_idx" ON "tbl_monthly_production_plan"("is_deleted");

CREATE UNIQUE INDEX "tbl_monthly_production_plan_detail_plan_id_line_number_key" ON "tbl_monthly_production_plan_detail"("plan_id", "line_number");
CREATE INDEX "tbl_monthly_production_plan_detail_plan_id_idx" ON "tbl_monthly_production_plan_detail"("plan_id");
CREATE INDEX "tbl_monthly_production_plan_detail_planned_order_number_idx" ON "tbl_monthly_production_plan_detail"("planned_order_number");
CREATE INDEX "tbl_monthly_production_plan_detail_manufacturing_order_number_idx" ON "tbl_monthly_production_plan_detail"("manufacturing_order_number");
CREATE INDEX "tbl_monthly_production_plan_detail_part_code_idx" ON "tbl_monthly_production_plan_detail"("part_code");
CREATE INDEX "tbl_monthly_production_plan_detail_part_id_idx" ON "tbl_monthly_production_plan_detail"("part_id");
CREATE INDEX "tbl_monthly_production_plan_detail_required_date_idx" ON "tbl_monthly_production_plan_detail"("required_date");
CREATE INDEX "tbl_monthly_production_plan_detail_status_idx" ON "tbl_monthly_production_plan_detail"("status");
CREATE INDEX "tbl_monthly_production_plan_detail_is_deleted_idx" ON "tbl_monthly_production_plan_detail"("is_deleted");

CREATE UNIQUE INDEX "tbl_daily_production_schedule_schedule_number_key" ON "tbl_daily_production_schedule"("schedule_number");
CREATE INDEX "tbl_daily_production_schedule_schedule_number_idx" ON "tbl_daily_production_schedule"("schedule_number");
CREATE INDEX "tbl_daily_production_schedule_schedule_date_idx" ON "tbl_daily_production_schedule"("schedule_date");
CREATE INDEX "tbl_daily_production_schedule_shift_idx" ON "tbl_daily_production_schedule"("shift");
CREATE INDEX "tbl_daily_production_schedule_mo_id_idx" ON "tbl_daily_production_schedule"("mo_id");
CREATE INDEX "tbl_daily_production_schedule_mo_number_idx" ON "tbl_daily_production_schedule"("mo_number");
CREATE INDEX "tbl_daily_production_schedule_wo_id_idx" ON "tbl_daily_production_schedule"("wo_id");
CREATE INDEX "tbl_daily_production_schedule_wo_number_idx" ON "tbl_daily_production_schedule"("wo_number");
CREATE INDEX "tbl_daily_production_schedule_part_id_idx" ON "tbl_daily_production_schedule"("part_id");
CREATE INDEX "tbl_daily_production_schedule_part_code_idx" ON "tbl_daily_production_schedule"("part_code");
CREATE INDEX "tbl_daily_production_schedule_process_id_idx" ON "tbl_daily_production_schedule"("process_id");
CREATE INDEX "tbl_daily_production_schedule_machine_id_idx" ON "tbl_daily_production_schedule"("machine_id");
CREATE INDEX "tbl_daily_production_schedule_status_idx" ON "tbl_daily_production_schedule"("status");
CREATE INDEX "tbl_daily_production_schedule_is_deleted_idx" ON "tbl_daily_production_schedule"("is_deleted");

ALTER TABLE "tbl_monthly_production_plan_detail"
ADD CONSTRAINT "tbl_monthly_production_plan_detail_plan_id_fkey"
FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
