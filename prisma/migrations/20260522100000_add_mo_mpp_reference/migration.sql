ALTER TABLE "tbl_manufacturing_order"
ADD COLUMN "monthly_production_plan_number" TEXT,
ADD COLUMN "monthly_production_plan_line_number" INTEGER;

CREATE INDEX "tbl_manufacturing_order_monthly_production_plan_number_idx"
ON "tbl_manufacturing_order"("monthly_production_plan_number");

CREATE INDEX "tbl_manufacturing_order_monthly_production_plan_line_number_idx"
ON "tbl_manufacturing_order"("monthly_production_plan_line_number");
