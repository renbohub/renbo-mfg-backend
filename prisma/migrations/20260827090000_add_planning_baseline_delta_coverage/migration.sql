ALTER TABLE "tbl_mps"
  ADD COLUMN "plan_kind" TEXT NOT NULL DEFAULT 'BASELINE',
  ADD COLUMN "baseline_mps_number" TEXT,
  ADD COLUMN "locked_at" TIMESTAMP(3),
  ADD COLUMN "locked_by" TEXT;

ALTER TABLE "tbl_mrp_run"
  ADD COLUMN "plan_kind" TEXT NOT NULL DEFAULT 'BASELINE',
  ADD COLUMN "baseline_run_number" TEXT,
  ADD COLUMN "source_delta_mps_number" TEXT,
  ADD COLUMN "locked_at" TIMESTAMP(3),
  ADD COLUMN "locked_by" TEXT;

CREATE TABLE "tbl_planning_baseline_lock" (
  "id" TEXT NOT NULL,
  "period_month" TIMESTAMP(3) NOT NULL,
  "customer_code" TEXT NOT NULL,
  "part_code" TEXT NOT NULL,
  "uom_code" TEXT,
  "forecast_qty_locked" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "po_qty_locked" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "efd_qty_locked" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "baseline_mps_number" TEXT,
  "baseline_mrp_number" TEXT,
  "source_fingerprint" TEXT NOT NULL,
  "source_snapshot" JSONB,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_planning_baseline_lock_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_additional_demand_coverage" (
  "id" TEXT NOT NULL,
  "baseline_lock_id" TEXT NOT NULL,
  "delivery_target_id" TEXT,
  "coverage_type" TEXT NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL,
  "source_number" TEXT,
  "source_line_id" TEXT,
  "available_date" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'ALLOCATED',
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB,
  "allocated_by" TEXT,
  "allocated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_by" TEXT,
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_additional_demand_coverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_additional_demand_coverage_baseline_lock_id_fkey"
    FOREIGN KEY ("baseline_lock_id") REFERENCES "tbl_planning_baseline_lock"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "tbl_planning_adjustment" (
  "id" TEXT NOT NULL,
  "adjustment_number" TEXT NOT NULL,
  "baseline_lock_id" TEXT NOT NULL,
  "adjustment_type" TEXT NOT NULL DEFAULT 'PRODUCTION_CUT',
  "requested_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "approved_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "applied_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "reason" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "source_snapshot" JSONB,
  "requested_by" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "applied_by" TEXT,
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_planning_adjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_planning_adjustment_baseline_lock_id_fkey"
    FOREIGN KEY ("baseline_lock_id") REFERENCES "tbl_planning_baseline_lock"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "tbl_planning_adjustment_line" (
  "id" TEXT NOT NULL,
  "adjustment_id" TEXT NOT NULL,
  "mps_number" TEXT,
  "mps_detail_id" TEXT,
  "mo_number" TEXT,
  "part_code" TEXT NOT NULL,
  "requested_cut_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "approved_cut_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "applied_cut_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "planned_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "produced_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "wip_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "supplier_po_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_planning_adjustment_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_planning_adjustment_line_adjustment_id_fkey"
    FOREIGN KEY ("adjustment_id") REFERENCES "tbl_planning_adjustment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_planning_baseline_lock_period_month_customer_code_part_code_key"
  ON "tbl_planning_baseline_lock"("period_month", "customer_code", "part_code");
CREATE INDEX "tbl_planning_baseline_lock_baseline_mps_number_idx" ON "tbl_planning_baseline_lock"("baseline_mps_number");
CREATE INDEX "tbl_planning_baseline_lock_baseline_mrp_number_idx" ON "tbl_planning_baseline_lock"("baseline_mrp_number");
CREATE INDEX "tbl_planning_baseline_lock_status_idx" ON "tbl_planning_baseline_lock"("status");

CREATE UNIQUE INDEX "tbl_additional_demand_coverage_idempotency_key_key" ON "tbl_additional_demand_coverage"("idempotency_key");
CREATE INDEX "tbl_additional_demand_coverage_baseline_lock_id_status_idx" ON "tbl_additional_demand_coverage"("baseline_lock_id", "status");
CREATE INDEX "tbl_additional_demand_coverage_delivery_target_id_idx" ON "tbl_additional_demand_coverage"("delivery_target_id");
CREATE INDEX "tbl_additional_demand_coverage_coverage_type_source_number_idx" ON "tbl_additional_demand_coverage"("coverage_type", "source_number");

CREATE UNIQUE INDEX "tbl_planning_adjustment_adjustment_number_key" ON "tbl_planning_adjustment"("adjustment_number");
CREATE INDEX "tbl_planning_adjustment_baseline_lock_id_status_idx" ON "tbl_planning_adjustment"("baseline_lock_id", "status");
CREATE INDEX "tbl_planning_adjustment_adjustment_type_idx" ON "tbl_planning_adjustment"("adjustment_type");

CREATE INDEX "tbl_planning_adjustment_line_adjustment_id_idx" ON "tbl_planning_adjustment_line"("adjustment_id");
CREATE INDEX "tbl_planning_adjustment_line_mps_number_mps_detail_id_idx" ON "tbl_planning_adjustment_line"("mps_number", "mps_detail_id");
CREATE INDEX "tbl_planning_adjustment_line_mo_number_idx" ON "tbl_planning_adjustment_line"("mo_number");

CREATE INDEX "tbl_mps_plan_kind_baseline_mps_number_idx" ON "tbl_mps"("plan_kind", "baseline_mps_number");
CREATE INDEX "tbl_mrp_run_plan_kind_baseline_run_number_source_delta_mps_number_idx"
  ON "tbl_mrp_run"("plan_kind", "baseline_run_number", "source_delta_mps_number");

ALTER TABLE "tbl_mps"
  ADD CONSTRAINT "tbl_mps_plan_kind_check" CHECK (UPPER("plan_kind") IN ('BASELINE', 'DELTA'));
ALTER TABLE "tbl_mrp_run"
  ADD CONSTRAINT "tbl_mrp_run_plan_kind_check" CHECK (UPPER("plan_kind") IN ('BASELINE', 'DELTA'));
ALTER TABLE "tbl_additional_demand_coverage"
  ADD CONSTRAINT "tbl_additional_demand_coverage_type_check" CHECK (UPPER("coverage_type") IN ('FG_STOCK', 'FIRM_FG_RECEIPT', 'DELTA_MPS'));
ALTER TABLE "tbl_additional_demand_coverage"
  ADD CONSTRAINT "tbl_additional_demand_coverage_status_check" CHECK (UPPER("status") IN ('ALLOCATED', 'RELEASED', 'SUPERSEDED'));
ALTER TABLE "tbl_planning_adjustment"
  ADD CONSTRAINT "tbl_planning_adjustment_status_check" CHECK (UPPER("status") IN ('DRAFT', 'APPROVED', 'REJECTED', 'APPLIED'));
