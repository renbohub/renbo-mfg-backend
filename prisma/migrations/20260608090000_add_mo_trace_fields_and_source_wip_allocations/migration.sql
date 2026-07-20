ALTER TABLE "tbl_manufacturing_order"
ADD COLUMN "parent_mo_number" TEXT,
ADD COLUMN "root_mo_number" TEXT,
ADD COLUMN "source_reference_type" TEXT,
ADD COLUMN "source_planned_order_number" TEXT,
ADD COLUMN "source_monthly_production_plan_number" TEXT,
ADD COLUMN "source_monthly_production_plan_line_number" INTEGER,
ADD COLUMN "source_start_sequence" INTEGER,
ADD COLUMN "source_start_process_label" TEXT,
ADD COLUMN "source_rework_trace_type" TEXT,
ADD COLUMN "source_rework_reference_type" TEXT,
ADD COLUMN "source_rework_reference_number" TEXT,
ADD COLUMN "source_rework_reference_label" TEXT,
ADD COLUMN "is_rework_child" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "tbl_manufacturing_order_parent_mo_number_idx" ON "tbl_manufacturing_order"("parent_mo_number");
CREATE INDEX "tbl_manufacturing_order_root_mo_number_idx" ON "tbl_manufacturing_order"("root_mo_number");
CREATE INDEX "tbl_manufacturing_order_source_reference_type_idx" ON "tbl_manufacturing_order"("source_reference_type");
CREATE INDEX "tbl_manufacturing_order_source_planned_order_number_idx" ON "tbl_manufacturing_order"("source_planned_order_number");
CREATE INDEX "tbl_manufacturing_order_source_start_sequence_idx" ON "tbl_manufacturing_order"("source_start_sequence");
CREATE INDEX "tbl_manufacturing_order_is_rework_child_idx" ON "tbl_manufacturing_order"("is_rework_child");

CREATE TABLE "tbl_manufacturing_order_source_wip" (
  "id" TEXT NOT NULL,
  "manufacturing_order_id" TEXT NOT NULL,
  "mo_number" TEXT NOT NULL,
  "line_number" INTEGER NOT NULL DEFAULT 1,
  "stock_balance_id" TEXT,
  "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "warehouse_code" TEXT,
  "rack_code" TEXT,
  "lot_number" TEXT,
  "part_code" TEXT,
  "part_number" TEXT,
  "part_name" TEXT,
  "stock_type" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tbl_manufacturing_order_source_wip_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_manufacturing_order_source_wip_manufacturing_order_id_idx" ON "tbl_manufacturing_order_source_wip"("manufacturing_order_id");
CREATE INDEX "tbl_manufacturing_order_source_wip_mo_number_idx" ON "tbl_manufacturing_order_source_wip"("mo_number");
CREATE INDEX "tbl_manufacturing_order_source_wip_stock_balance_id_idx" ON "tbl_manufacturing_order_source_wip"("stock_balance_id");
CREATE INDEX "tbl_manufacturing_order_source_wip_line_number_idx" ON "tbl_manufacturing_order_source_wip"("line_number");
CREATE INDEX "tbl_manufacturing_order_source_wip_is_deleted_idx" ON "tbl_manufacturing_order_source_wip"("is_deleted");

ALTER TABLE "tbl_manufacturing_order_source_wip"
ADD CONSTRAINT "tbl_manufacturing_order_source_wip_manufacturing_order_id_fkey"
FOREIGN KEY ("manufacturing_order_id") REFERENCES "tbl_manufacturing_order"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_manufacturing_order_source_wip"
ADD CONSTRAINT "tbl_manufacturing_order_source_wip_stock_balance_id_fkey"
FOREIGN KEY ("stock_balance_id") REFERENCES "tbl_stock_balance"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
