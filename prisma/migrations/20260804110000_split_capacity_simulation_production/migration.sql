ALTER TABLE "tbl_production_plan_allocation"
ADD COLUMN "planning_mode" TEXT NOT NULL DEFAULT 'PRODUCTION',
ADD COLUMN "scenario_key" TEXT;

CREATE INDEX "tbl_production_plan_allocation_planning_mode_scenario_key_idx"
ON "tbl_production_plan_allocation"("planning_mode", "scenario_key");
