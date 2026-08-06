CREATE TABLE "tbl_demand_delivery_target" (
  "id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_number" TEXT NOT NULL,
  "source_line_id" TEXT NOT NULL,
  "forecast_detail_id" TEXT,
  "so_detail_id" TEXT,
  "phase_number" INTEGER NOT NULL,
  "customer_code" TEXT,
  "part_code" TEXT NOT NULL,
  "target_date" TIMESTAMP(3) NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL,
  "uom_code" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "notes" TEXT,
  "created_by" TEXT,
  "updated_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_demand_delivery_target_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tbl_mps_demand_source"
  ADD COLUMN "required_date" TIMESTAMP(3),
  ADD COLUMN "effective_required_date" TIMESTAMP(3);

ALTER TABLE "tbl_mps_delivery_plan"
  ADD COLUMN "source_delivery_target_id" TEXT,
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "locked_by_source" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "tbl_demand_delivery_target_source_type_source_line_id_phase_number_key"
  ON "tbl_demand_delivery_target"("source_type", "source_line_id", "phase_number");
CREATE INDEX "tbl_demand_delivery_target_source_number_idx" ON "tbl_demand_delivery_target"("source_number");
CREATE INDEX "tbl_demand_delivery_target_forecast_detail_id_idx" ON "tbl_demand_delivery_target"("forecast_detail_id");
CREATE INDEX "tbl_demand_delivery_target_so_detail_id_idx" ON "tbl_demand_delivery_target"("so_detail_id");
CREATE INDEX "tbl_demand_delivery_target_part_code_target_date_idx" ON "tbl_demand_delivery_target"("part_code", "target_date");
CREATE INDEX "tbl_demand_delivery_target_is_deleted_idx" ON "tbl_demand_delivery_target"("is_deleted");
CREATE INDEX "tbl_mps_delivery_plan_source_delivery_target_id_idx" ON "tbl_mps_delivery_plan"("source_delivery_target_id");

ALTER TABLE "tbl_demand_delivery_target"
  ADD CONSTRAINT "tbl_demand_delivery_target_forecast_detail_id_fkey"
  FOREIGN KEY ("forecast_detail_id") REFERENCES "tbl_forecast_detail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_demand_delivery_target"
  ADD CONSTRAINT "tbl_demand_delivery_target_so_detail_id_fkey"
  FOREIGN KEY ("so_detail_id") REFERENCES "tbl_salesorderdetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
