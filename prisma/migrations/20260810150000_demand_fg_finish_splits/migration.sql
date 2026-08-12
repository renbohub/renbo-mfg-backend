ALTER TABLE "tbl_demand_planning_decision"
ADD COLUMN "fg_finish_splits" JSONB;

ALTER TABLE "tbl_mps_delivery_plan"
ADD COLUMN "fg_required_date" TIMESTAMP(3),
ADD COLUMN "fg_finish_split_number" INTEGER;

CREATE INDEX "tbl_mps_delivery_plan_fg_required_date_idx"
ON "tbl_mps_delivery_plan"("fg_required_date");
