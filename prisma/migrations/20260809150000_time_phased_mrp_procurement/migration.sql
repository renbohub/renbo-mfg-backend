ALTER TABLE "tbl_mps_detail"
  ADD COLUMN "demand_policy" TEXT NOT NULL DEFAULT 'MTO';

ALTER TABLE "tbl_mrp_run"
  ADD COLUMN "planning_snapshot_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "scenario_key" TEXT,
  ADD COLUMN "scenario_name" TEXT,
  ADD COLUMN "scenario_status" TEXT NOT NULL DEFAULT 'BASELINE',
  ADD COLUMN "scenario_assumptions" JSONB;

ALTER TABLE "tbl_mrp_requirement"
  ADD COLUMN "firm_supply_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "planned_supply_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "firm_net_requirement" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "at_risk_supply_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "projected_available_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "firm_projected_available_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "supply_timeline" JSONB,
  ADD COLUMN "latest_pr_date" TIMESTAMP(3),
  ADD COLUMN "procurement_window" TEXT,
  ADD COLUMN "schedule_source" TEXT;

ALTER TABLE "tbl_purchase_suggestion_item"
  ADD COLUMN "latest_pr_date" TIMESTAMP(3),
  ADD COLUMN "procurement_window" TEXT,
  ADD COLUMN "schedule_source" TEXT,
  ADD COLUMN "at_risk_supply_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX "tbl_mrp_run_scenario_key_idx" ON "tbl_mrp_run"("scenario_key");
CREATE INDEX "tbl_mrp_run_scenario_status_idx" ON "tbl_mrp_run"("scenario_status");
CREATE INDEX "tbl_mrp_requirement_latest_pr_date_idx" ON "tbl_mrp_requirement"("latest_pr_date");
CREATE INDEX "tbl_mrp_requirement_procurement_window_idx" ON "tbl_mrp_requirement"("procurement_window");
CREATE INDEX "tbl_purchase_suggestion_item_latest_pr_date_idx" ON "tbl_purchase_suggestion_item"("latest_pr_date");
CREATE INDEX "tbl_purchase_suggestion_item_procurement_window_idx" ON "tbl_purchase_suggestion_item"("procurement_window");
