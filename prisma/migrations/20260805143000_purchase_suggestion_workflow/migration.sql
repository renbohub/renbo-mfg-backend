CREATE TABLE "tbl_purchase_suggestion" (
  "id" TEXT NOT NULL,
  "suggestion_number" TEXT NOT NULL,
  "run_number" TEXT NOT NULL,
  "warehouse_code" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "generated_by" TEXT,
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_purchase_suggestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_purchase_suggestion_item" (
  "id" TEXT NOT NULL,
  "suggestion_number" TEXT NOT NULL,
  "planned_order_number" TEXT NOT NULL,
  "mrp_requirement_id" TEXT,
  "part_id" TEXT,
  "part_code" TEXT,
  "part_number" TEXT,
  "part_name" TEXT,
  "material_id" TEXT,
  "material_code" TEXT,
  "material_description" TEXT,
  "uom_code" TEXT,
  "warehouse_code" TEXT,
  "source_requirements" JSONB,
  "customer_codes" JSONB,
  "sales_order_numbers" JSONB,
  "forecast_numbers" JSONB,
  "production_order_numbers" JSONB,
  "customer_delivery_date" TIMESTAMP(3),
  "planned_production_start" TIMESTAMP(3),
  "material_required_date" TIMESTAMP(3) NOT NULL,
  "recommended_order_date" TIMESTAMP(3) NOT NULL,
  "production_lead_time_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "purchasing_lead_time_days" INTEGER NOT NULL DEFAULT 0,
  "setup_time_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "cycle_time_seconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "queue_buffer_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "gross_requirement" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "on_hand_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reserved_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "available_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "open_po_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "net_requirement" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "recommended_purchase_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "moq" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "order_multiple" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "excess_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "projected_stock_after_order" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "suggested_supplier_code" TEXT,
  "suggested_supplier_name" TEXT,
  "estimated_unit_price" DOUBLE PRECISION,
  "currency_code" TEXT,
  "confirmation_status" TEXT NOT NULL DEFAULT 'Not Confirmed',
  "confirmed_qty" DOUBLE PRECISION,
  "confirmed_delivery_date" TIMESTAMP(3),
  "confirmed_moq" DOUBLE PRECISION,
  "confirmed_lead_time_days" INTEGER,
  "supplier_remark" TEXT,
  "alternative_supplier_code" TEXT,
  "alternative_material_code" TEXT,
  "bypass_confirmation_reason" TEXT,
  "shortage_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pr_number" TEXT,
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_purchase_suggestion_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_purchase_suggestion_supplier_allocation" (
  "id" TEXT NOT NULL,
  "suggestion_item_id" TEXT NOT NULL,
  "supplier_code" TEXT,
  "supplier_name" TEXT,
  "confirmation_status" TEXT NOT NULL DEFAULT 'Not Confirmed',
  "offered_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "confirmed_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "delivery_date" TIMESTAMP(3),
  "moq" DOUBLE PRECISION,
  "order_multiple" DOUBLE PRECISION,
  "lead_time_days" INTEGER,
  "unit_price" DOUBLE PRECISION,
  "currency_code" TEXT,
  "alternative_material_code" TEXT,
  "supplier_remark" TEXT,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'Draft',
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_purchase_suggestion_supplier_allocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_purchase_suggestion_suggestion_number_key" ON "tbl_purchase_suggestion"("suggestion_number");
CREATE INDEX "tbl_purchase_suggestion_run_number_idx" ON "tbl_purchase_suggestion"("run_number");
CREATE INDEX "tbl_purchase_suggestion_warehouse_code_idx" ON "tbl_purchase_suggestion"("warehouse_code");
CREATE INDEX "tbl_purchase_suggestion_status_idx" ON "tbl_purchase_suggestion"("status");
CREATE INDEX "tbl_purchase_suggestion_is_deleted_idx" ON "tbl_purchase_suggestion"("is_deleted");

CREATE UNIQUE INDEX "tbl_purchase_suggestion_item_suggestion_number_planned_order_number_key" ON "tbl_purchase_suggestion_item"("suggestion_number", "planned_order_number");
CREATE INDEX "tbl_purchase_suggestion_item_planned_order_number_idx" ON "tbl_purchase_suggestion_item"("planned_order_number");
CREATE INDEX "tbl_purchase_suggestion_item_mrp_requirement_id_idx" ON "tbl_purchase_suggestion_item"("mrp_requirement_id");
CREATE INDEX "tbl_purchase_suggestion_item_part_code_idx" ON "tbl_purchase_suggestion_item"("part_code");
CREATE INDEX "tbl_purchase_suggestion_item_material_code_idx" ON "tbl_purchase_suggestion_item"("material_code");
CREATE INDEX "tbl_purchase_suggestion_item_warehouse_code_idx" ON "tbl_purchase_suggestion_item"("warehouse_code");
CREATE INDEX "tbl_purchase_suggestion_item_material_required_date_idx" ON "tbl_purchase_suggestion_item"("material_required_date");
CREATE INDEX "tbl_purchase_suggestion_item_recommended_order_date_idx" ON "tbl_purchase_suggestion_item"("recommended_order_date");
CREATE INDEX "tbl_purchase_suggestion_item_suggested_supplier_code_idx" ON "tbl_purchase_suggestion_item"("suggested_supplier_code");
CREATE INDEX "tbl_purchase_suggestion_item_confirmation_status_idx" ON "tbl_purchase_suggestion_item"("confirmation_status");
CREATE INDEX "tbl_purchase_suggestion_item_status_idx" ON "tbl_purchase_suggestion_item"("status");
CREATE INDEX "tbl_purchase_suggestion_item_pr_number_idx" ON "tbl_purchase_suggestion_item"("pr_number");
CREATE INDEX "tbl_purchase_suggestion_item_is_deleted_idx" ON "tbl_purchase_suggestion_item"("is_deleted");

CREATE INDEX "tbl_purchase_suggestion_supplier_allocation_suggestion_item_id_idx" ON "tbl_purchase_suggestion_supplier_allocation"("suggestion_item_id");
CREATE INDEX "tbl_purchase_suggestion_supplier_allocation_supplier_code_idx" ON "tbl_purchase_suggestion_supplier_allocation"("supplier_code");
CREATE INDEX "tbl_purchase_suggestion_supplier_allocation_confirmation_status_idx" ON "tbl_purchase_suggestion_supplier_allocation"("confirmation_status");
CREATE INDEX "tbl_purchase_suggestion_supplier_allocation_delivery_date_idx" ON "tbl_purchase_suggestion_supplier_allocation"("delivery_date");
CREATE INDEX "tbl_purchase_suggestion_supplier_allocation_status_idx" ON "tbl_purchase_suggestion_supplier_allocation"("status");
CREATE INDEX "tbl_purchase_suggestion_supplier_allocation_is_deleted_idx" ON "tbl_purchase_suggestion_supplier_allocation"("is_deleted");

ALTER TABLE "tbl_purchase_suggestion_item"
  ADD CONSTRAINT "tbl_purchase_suggestion_item_suggestion_number_fkey"
  FOREIGN KEY ("suggestion_number") REFERENCES "tbl_purchase_suggestion"("suggestion_number") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_purchase_suggestion_supplier_allocation"
  ADD CONSTRAINT "tbl_purchase_suggestion_supplier_allocation_suggestion_item_id_fkey"
  FOREIGN KEY ("suggestion_item_id") REFERENCES "tbl_purchase_suggestion_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

WITH permissions("role_code", "actions") AS (
  VALUES
    ('PPIC_PLANNER', '["read","create"]'::jsonb),
    ('PPIC_SUPERVISOR', '["read","create","update","release"]'::jsonb),
    ('PURCHASING_STAFF', '["read","create","update","submit"]'::jsonb),
    ('PURCHASING_MANAGER', '["read","create","update","delete","approve","submit","release"]'::jsonb)
)
INSERT INTO "tbl_role_permissions" (
  "id", "role_id", "module_code", "page_code", "resource_code", "actions",
  "is_active", "is_deleted", "created_by", "updated_by", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, role."id", 'purchasing', 'purchase-suggestions', 'purchaseSuggestions', p.actions,
       true, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM permissions p
JOIN "tbl_roles" role ON role."role_code" = p.role_code
ON CONFLICT ("role_id", "module_code", "page_code") DO UPDATE SET
  "resource_code" = EXCLUDED."resource_code", "actions" = EXCLUDED."actions",
  "is_active" = true, "is_deleted" = false, "updated_by" = 'migration', "updated_at" = CURRENT_TIMESTAMP;
