-- Planning Architecture V2 is intentionally additive. Historical rows and
-- legacy columns remain untouched for compatibility.

ALTER TABLE "tbl_salesorderdetail"
  ADD COLUMN IF NOT EXISTS "price_source" TEXT,
  ADD COLUMN IF NOT EXISTS "price_source_id" TEXT,
  ADD COLUMN IF NOT EXISTS "original_master_price" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "price_override_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "price_overridden_by" TEXT,
  ADD COLUMN IF NOT EXISTS "price_overridden_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "estimated_material_cost" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimated_process_cost" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimated_overhead_cost" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimated_bom_cost_per_unit" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimated_total_cost" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimated_gross_contribution" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimated_margin_percent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "costing_status" TEXT;

ALTER TABLE "tbl_mps"
  ADD COLUMN IF NOT EXISTS "planning_anchor_month" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lifecycle_status" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "simulation_only" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "source_delta" JSONB;

ALTER TABLE "tbl_mps_detail"
  ADD COLUMN IF NOT EXISTS "delivery_phase_id" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_target_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fg_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priority_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priority_class" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_mps_detail_delivery_phase_id_idx" ON "tbl_mps_detail"("delivery_phase_id");
CREATE INDEX IF NOT EXISTS "tbl_mps_detail_fg_required_date_idx" ON "tbl_mps_detail"("fg_required_date");

ALTER TABLE "tbl_mps_demand_source"
  ADD COLUMN IF NOT EXISTS "delivery_target_id" TEXT,
  ADD COLUMN IF NOT EXISTS "target_delivery_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fg_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priority_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priority_class" TEXT,
  ADD COLUMN IF NOT EXISTS "buffer_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "buffer_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "source_pegging" JSONB;

CREATE INDEX IF NOT EXISTS "tbl_mps_demand_source_delivery_target_id_idx" ON "tbl_mps_demand_source"("delivery_target_id");

ALTER TABLE "tbl_mps_delivery_plan" ADD COLUMN IF NOT EXISTS "source_number" TEXT;
CREATE INDEX IF NOT EXISTS "tbl_mps_delivery_plan_source_type_source_number_idx" ON "tbl_mps_delivery_plan"("source_type", "source_number");

CREATE TABLE IF NOT EXISTS "tbl_demand_planning_decision" (
  "id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_number" TEXT NOT NULL,
  "source_line_id" TEXT NOT NULL,
  "delivery_target_id" TEXT NOT NULL,
  "customer_code" TEXT,
  "part_code" TEXT NOT NULL,
  "target_delivery_date" TIMESTAMP(3) NOT NULL,
  "demand_qty" DOUBLE PRECISION NOT NULL,
  "system_priority_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "manual_priority_adjustment" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "manual_adjustment_reason" TEXT,
  "final_priority_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "priority_class" TEXT NOT NULL DEFAULT 'P2',
  "priority_score_breakdown" JSONB,
  "urgent_flag" BOOLEAN NOT NULL DEFAULT false,
  "fg_required_date" TIMESTAMP(3),
  "buffer_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "buffer_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "displacement_policy" TEXT NOT NULL DEFAULT 'SIMULATE_FIRST',
  "displacement_reason" TEXT,
  "feasibility_status" TEXT NOT NULL DEFAULT 'NOT_SIMULATED',
  "earliest_feasible_delivery_date" TIMESTAMP(3),
  "critical_constraint" TEXT,
  "constraint_details" JSONB,
  "material_status" TEXT,
  "capacity_status" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
  "source_changed_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_demand_planning_decision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tbl_demand_planning_decision_delivery_target_id_key" ON "tbl_demand_planning_decision"("delivery_target_id");
CREATE INDEX IF NOT EXISTS "tbl_demand_planning_decision_source_type_source_number_idx" ON "tbl_demand_planning_decision"("source_type", "source_number");
CREATE INDEX IF NOT EXISTS "tbl_demand_planning_decision_customer_code_target_delivery_date_idx" ON "tbl_demand_planning_decision"("customer_code", "target_delivery_date");
CREATE INDEX IF NOT EXISTS "tbl_demand_planning_decision_part_code_target_delivery_date_idx" ON "tbl_demand_planning_decision"("part_code", "target_delivery_date");
CREATE INDEX IF NOT EXISTS "tbl_demand_planning_decision_priority_class_final_priority_score_idx" ON "tbl_demand_planning_decision"("priority_class", "final_priority_score");
CREATE INDEX IF NOT EXISTS "tbl_demand_planning_decision_status_idx" ON "tbl_demand_planning_decision"("status");
CREATE INDEX IF NOT EXISTS "tbl_demand_planning_decision_is_deleted_idx" ON "tbl_demand_planning_decision"("is_deleted");

CREATE TABLE IF NOT EXISTS "tbl_customer_part_price" (
  "id" TEXT NOT NULL,
  "customer_code" TEXT NOT NULL,
  "part_id" TEXT NOT NULL,
  "currency_code" TEXT NOT NULL DEFAULT 'IDR',
  "unit_price" DOUBLE PRECISION NOT NULL,
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_until" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_customer_part_price_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tbl_customer_part_price_customer_code_part_id_currency_code_effective_from_key" ON "tbl_customer_part_price"("customer_code", "part_id", "currency_code", "effective_from");
CREATE INDEX IF NOT EXISTS "tbl_customer_part_price_customer_code_part_id_currency_code_idx" ON "tbl_customer_part_price"("customer_code", "part_id", "currency_code");
CREATE INDEX IF NOT EXISTS "tbl_customer_part_price_effective_from_effective_until_idx" ON "tbl_customer_part_price"("effective_from", "effective_until");
CREATE INDEX IF NOT EXISTS "tbl_customer_part_price_is_active_is_deleted_idx" ON "tbl_customer_part_price"("is_active", "is_deleted");

ALTER TABLE "tbl_mrp_run" ADD COLUMN IF NOT EXISTS "planning_month" TIMESTAMP(3);

ALTER TABLE "tbl_mrp_requirement"
  ADD COLUMN IF NOT EXISTS "root_demand_source_type" TEXT,
  ADD COLUMN IF NOT EXISTS "root_demand_source_number" TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_target_id" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_code" TEXT,
  ADD COLUMN IF NOT EXISTS "fg_part_code" TEXT,
  ADD COLUMN IF NOT EXISTS "target_delivery_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "parent_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "material_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "production_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "supplier_required_arrival_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vendor_send_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vendor_return_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priority_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priority_class" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_pegging" JSONB;

CREATE INDEX IF NOT EXISTS "tbl_mrp_requirement_delivery_target_id_idx" ON "tbl_mrp_requirement"("delivery_target_id");
CREATE INDEX IF NOT EXISTS "tbl_mrp_requirement_customer_code_target_delivery_date_idx" ON "tbl_mrp_requirement"("customer_code", "target_delivery_date");

ALTER TABLE "tbl_monthly_production_plan_detail"
  ADD COLUMN IF NOT EXISTS "delivery_phase_id" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_code" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_target_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fg_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priority_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priority_class" TEXT,
  ADD COLUMN IF NOT EXISTS "latest_start_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "latest_finish_date" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "tbl_monthly_production_plan_detail_delivery_phase_id_idx" ON "tbl_monthly_production_plan_detail"("delivery_phase_id");
CREATE INDEX IF NOT EXISTS "tbl_monthly_production_plan_detail_fg_required_date_idx" ON "tbl_monthly_production_plan_detail"("fg_required_date");

ALTER TABLE "tbl_production_plan_allocation"
  ADD COLUMN IF NOT EXISTS "demand_source_type" TEXT,
  ADD COLUMN IF NOT EXISTS "demand_source_number" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_code" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_target_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fg_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priority_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priority_class" TEXT,
  ADD COLUMN IF NOT EXISTS "latest_start_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "latest_finish_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "earliest_feasible_completion" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "late_constraint_code" TEXT;

ALTER TABLE "tbl_daily_production_schedule"
  ADD COLUMN IF NOT EXISTS "demand_source_type" TEXT,
  ADD COLUMN IF NOT EXISTS "demand_source_number" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_code" TEXT,
  ADD COLUMN IF NOT EXISTS "customer_target_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fg_required_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "priority_score" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priority_class" TEXT,
  ADD COLUMN IF NOT EXISTS "material_readiness_status" TEXT,
  ADD COLUMN IF NOT EXISTS "predecessor_status" TEXT,
  ADD COLUMN IF NOT EXISTS "vendor_status" TEXT,
  ADD COLUMN IF NOT EXISTS "late_risk" TEXT,
  ADD COLUMN IF NOT EXISTS "mrp_run_number" TEXT,
  ADD COLUMN IF NOT EXISTS "mps_number" TEXT,
  ADD COLUMN IF NOT EXISTS "mpp_number" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_exception" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "manual_exception_reason" TEXT;

CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_demand_source_type_demand_source_number_idx" ON "tbl_daily_production_schedule"("demand_source_type", "demand_source_number");
CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_mps_number_idx" ON "tbl_daily_production_schedule"("mps_number");
CREATE INDEX IF NOT EXISTS "tbl_daily_production_schedule_mrp_run_number_idx" ON "tbl_daily_production_schedule"("mrp_run_number");
