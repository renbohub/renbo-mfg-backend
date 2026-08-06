ALTER TABLE "tbl_excel_import_batch"
  ADD COLUMN "import_type" TEXT NOT NULL DEFAULT 'FORECAST',
  ADD COLUMN "applied_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliation_json" JSONB;

CREATE INDEX "tbl_excel_import_batch_import_type_idx"
  ON "tbl_excel_import_batch"("import_type");

-- Material form is selected by BOM/purchasing and is intentionally excluded
-- from identity. Existing data was audited before this migration: no active
-- duplicate group exists for substance + grade/thickness + width.
CREATE UNIQUE INDEX "tbl_material_active_identity_key"
  ON "tbl_material"("material_substance_id", "material_grade_id", "width")
  WHERE "is_deleted" = false
    AND "material_substance_id" IS NOT NULL
    AND "material_grade_id" IS NOT NULL
    AND "width" IS NOT NULL;

CREATE TABLE "tbl_sales_actual_ledger" (
  "id" TEXT NOT NULL,
  "identity_key" TEXT NOT NULL,
  "actual_basis" TEXT NOT NULL,
  "actual_date" TIMESTAMP(3) NOT NULL,
  "period_month" TIMESTAMP(3) NOT NULL,
  "customer_code" TEXT,
  "customer_name" TEXT,
  "part_id" TEXT,
  "part_code" TEXT,
  "part_number" TEXT,
  "part_name" TEXT,
  "business_category" TEXT,
  "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "uom_code" TEXT,
  "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "currency_code" TEXT NOT NULL DEFAULT 'IDR',
  "exchange_rate_to_idr" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "amount_idr" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "source_type" TEXT NOT NULL DEFAULT 'EXCEL_IMPORT',
  "source_number" TEXT,
  "source_batch_number" TEXT,
  "import_batch_id" TEXT,
  "import_row_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_sales_actual_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_sales_actual_ledger_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "tbl_excel_import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tbl_sales_actual_ledger_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "tbl_excel_import_row"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_sales_actual_ledger_identity_key_key" ON "tbl_sales_actual_ledger"("identity_key");
CREATE INDEX "tbl_sales_actual_ledger_actual_basis_actual_date_idx" ON "tbl_sales_actual_ledger"("actual_basis", "actual_date");
CREATE INDEX "tbl_sales_actual_ledger_period_month_idx" ON "tbl_sales_actual_ledger"("period_month");
CREATE INDEX "tbl_sales_actual_ledger_customer_code_idx" ON "tbl_sales_actual_ledger"("customer_code");
CREATE INDEX "tbl_sales_actual_ledger_part_code_idx" ON "tbl_sales_actual_ledger"("part_code");
CREATE INDEX "tbl_sales_actual_ledger_part_number_idx" ON "tbl_sales_actual_ledger"("part_number");
CREATE INDEX "tbl_sales_actual_ledger_business_category_idx" ON "tbl_sales_actual_ledger"("business_category");
CREATE INDEX "tbl_sales_actual_ledger_source_batch_number_idx" ON "tbl_sales_actual_ledger"("source_batch_number");
CREATE INDEX "tbl_sales_actual_ledger_status_is_deleted_idx" ON "tbl_sales_actual_ledger"("status", "is_deleted");

CREATE TABLE "tbl_material_demand_snapshot" (
  "id" TEXT NOT NULL,
  "identity_key" TEXT NOT NULL,
  "period_month" TIMESTAMP(3) NOT NULL,
  "material_id" TEXT,
  "material_code" TEXT,
  "material_spec" TEXT,
  "thickness" DOUBLE PRECISION,
  "width" DOUBLE PRECISION,
  "material_form" TEXT,
  "part_id" TEXT,
  "part_code" TEXT,
  "part_number" TEXT,
  "part_name" TEXT,
  "customer_code" TEXT,
  "pitch" DOUBLE PRECISION,
  "cavity" INTEGER,
  "gross_weight_kg" DOUBLE PRECISION,
  "demand_qty_pcs" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "demand_qty_kg" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "warehouse_code" TEXT,
  "rack_code" TEXT,
  "source_batch_number" TEXT,
  "import_batch_id" TEXT,
  "import_row_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_material_demand_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_material_demand_snapshot_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "tbl_excel_import_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tbl_material_demand_snapshot_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "tbl_excel_import_row"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_material_demand_snapshot_identity_key_key" ON "tbl_material_demand_snapshot"("identity_key");
CREATE INDEX "tbl_material_demand_snapshot_period_month_idx" ON "tbl_material_demand_snapshot"("period_month");
CREATE INDEX "tbl_material_demand_snapshot_material_id_idx" ON "tbl_material_demand_snapshot"("material_id");
CREATE INDEX "tbl_material_demand_snapshot_material_code_idx" ON "tbl_material_demand_snapshot"("material_code");
CREATE INDEX "tbl_material_demand_snapshot_material_spec_thickness_width_idx" ON "tbl_material_demand_snapshot"("material_spec", "thickness", "width");
CREATE INDEX "tbl_material_demand_snapshot_part_code_idx" ON "tbl_material_demand_snapshot"("part_code");
CREATE INDEX "tbl_material_demand_snapshot_customer_code_idx" ON "tbl_material_demand_snapshot"("customer_code");
CREATE INDEX "tbl_material_demand_snapshot_source_batch_number_idx" ON "tbl_material_demand_snapshot"("source_batch_number");
CREATE INDEX "tbl_material_demand_snapshot_status_is_deleted_idx" ON "tbl_material_demand_snapshot"("status", "is_deleted");

CREATE TABLE "tbl_mps_demand_source" (
  "id" TEXT NOT NULL,
  "mps_detail_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_number" TEXT NOT NULL,
  "source_line_id" TEXT,
  "forecast_detail_id" TEXT,
  "so_detail_id" TEXT,
  "customer_code" TEXT,
  "period_month" TIMESTAMP(3) NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL,
  "uom_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_mps_demand_source_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_mps_demand_source_mps_detail_id_fkey" FOREIGN KEY ("mps_detail_id") REFERENCES "tbl_mps_detail"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_mps_demand_source_forecast_detail_id_fkey" FOREIGN KEY ("forecast_detail_id") REFERENCES "tbl_forecast_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "tbl_mps_demand_source_so_detail_id_fkey" FOREIGN KEY ("so_detail_id") REFERENCES "tbl_salesorderdetail"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_mps_demand_source_mps_detail_source_key" ON "tbl_mps_demand_source"("mps_detail_id", "source_type", "source_number", "source_line_id");
CREATE INDEX "tbl_mps_demand_source_mps_detail_id_idx" ON "tbl_mps_demand_source"("mps_detail_id");
CREATE INDEX "tbl_mps_demand_source_source_type_source_number_idx" ON "tbl_mps_demand_source"("source_type", "source_number");
CREATE INDEX "tbl_mps_demand_source_forecast_detail_id_idx" ON "tbl_mps_demand_source"("forecast_detail_id");
CREATE INDEX "tbl_mps_demand_source_so_detail_id_idx" ON "tbl_mps_demand_source"("so_detail_id");
CREATE INDEX "tbl_mps_demand_source_period_month_idx" ON "tbl_mps_demand_source"("period_month");
