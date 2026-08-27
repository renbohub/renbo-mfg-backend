CREATE TABLE "tbl_monthly_plan_recommendation_scenario" (
  "id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "base_plan_updated_at" TIMESTAMP(3) NOT NULL,
  "rule_version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CALCULATING',
  "input_snapshot" JSONB NOT NULL,
  "summary" JSONB,
  "error_message" TEXT,
  "created_by" TEXT,
  "applied_by" TEXT,
  "applied_at" TIMESTAMP(3),
  "discarded_by" TEXT,
  "discarded_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_monthly_plan_recommendation_scenario_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_monthly_plan_recommendation_scenario_plan_id_status_idx"
  ON "tbl_monthly_plan_recommendation_scenario"("plan_id", "status");
CREATE INDEX "tbl_monthly_plan_recommendation_scenario_base_plan_updated_at_idx"
  ON "tbl_monthly_plan_recommendation_scenario"("base_plan_updated_at");
ALTER TABLE "tbl_monthly_plan_recommendation_scenario"
  ADD CONSTRAINT "tbl_monthly_plan_recommendation_scenario_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "tbl_monthly_production_plan"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tbl_monthly_plan_recommendation_item" (
  "id" TEXT NOT NULL,
  "scenario_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "item_type" TEXT NOT NULL,
  "change_type" TEXT,
  "work_center_id" TEXT,
  "source_allocation_id" TEXT,
  "line_number" INTEGER,
  "mbom_process_id" TEXT,
  "part_code" TEXT,
  "process_code" TEXT,
  "proposed_value" JSONB NOT NULL,
  "reason_code" TEXT NOT NULL,
  "trace" JSONB NOT NULL,
  "apply_status" TEXT NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_monthly_plan_recommendation_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_monthly_plan_recommendation_item_scenario_id_sequence_key"
  ON "tbl_monthly_plan_recommendation_item"("scenario_id", "sequence");
CREATE INDEX "tbl_monthly_plan_recommendation_item_scenario_id_item_type_idx"
  ON "tbl_monthly_plan_recommendation_item"("scenario_id", "item_type");
CREATE INDEX "tbl_monthly_plan_recommendation_item_scenario_id_apply_status_idx"
  ON "tbl_monthly_plan_recommendation_item"("scenario_id", "apply_status");
CREATE INDEX "tbl_monthly_plan_recommendation_item_work_center_id_idx"
  ON "tbl_monthly_plan_recommendation_item"("work_center_id");
ALTER TABLE "tbl_monthly_plan_recommendation_item"
  ADD CONSTRAINT "tbl_monthly_plan_recommendation_item_scenario_id_fkey"
  FOREIGN KEY ("scenario_id") REFERENCES "tbl_monthly_plan_recommendation_scenario"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
