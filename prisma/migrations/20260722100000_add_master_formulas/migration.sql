CREATE TABLE IF NOT EXISTS "tbl_master_formulas" (
  "id" TEXT NOT NULL,
  "formula_code" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "formula_key" TEXT NOT NULL,
  "formula_name" TEXT NOT NULL,
  "expression" TEXT NOT NULL,
  "variables" JSONB,
  "result_type" TEXT NOT NULL DEFAULT 'number',
  "version" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "effective_from" TIMESTAMP(3),
  "effective_until" TIMESTAMP(3),
  "created_by" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_master_formulas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_master_formulas_formula_code_key" ON "tbl_master_formulas"("formula_code");
CREATE UNIQUE INDEX IF NOT EXISTS "tbl_master_formulas_module_code_formula_key_version_key" ON "tbl_master_formulas"("module_code", "formula_key", "version");
CREATE INDEX IF NOT EXISTS "tbl_master_formulas_module_code_formula_key_idx" ON "tbl_master_formulas"("module_code", "formula_key");
CREATE INDEX IF NOT EXISTS "tbl_master_formulas_is_active_is_deleted_idx" ON "tbl_master_formulas"("is_active", "is_deleted");

INSERT INTO "tbl_master_formulas" ("id","formula_code","module_code","formula_key","formula_name","expression","variables","description") VALUES
  (gen_random_uuid()::text,'PLANNING_MPS_BUFFER_QTY','planning','MPS_BUFFER_QTY','MPS Buffer Quantity','round(bufferBaseQty * bufferPercent / 100, 6)','{"bufferBaseQty":"number","bufferPercent":"number"}','Buffer stock quantity on MPS.'),
  (gen_random_uuid()::text,'PLANNING_MPS_EFFECTIVE_DEMAND','planning','MPS_EFFECTIVE_DEMAND','MPS Effective Demand','forecastQty + bufferQty','{"forecastQty":"number","bufferQty":"number"}','Forecast plus buffer.'),
  (gen_random_uuid()::text,'PLANNING_MPS_TARGET_QTY','planning','MPS_TARGET_QTY','MPS Target Quantity','max(effectiveDemandQty * productionPercent / 100, actualSalesOrderQty)','{"effectiveDemandQty":"number","productionPercent":"number","actualSalesOrderQty":"number"}','Production target with SO minimum.'),
  (gen_random_uuid()::text,'PLANNING_MRP_NET_REQUIREMENT','planning','MRP_NET_REQUIREMENT','MRP Net Requirement','max(grossRequirement - projectedAvailable, 0)','{"grossRequirement":"number","projectedAvailable":"number"}','Net requirement after projected stock.'),
  (gen_random_uuid()::text,'PLANNING_MRP_ADJUSTED_ORDER','planning','MRP_ADJUSTED_ORDER','MRP Adjusted Order','max(netRequirement * orderPercent / 100, soConsumedQty)','{"netRequirement":"number","orderPercent":"number","soConsumedQty":"number"}','Adjusted planned order with actual SO minimum.'),
  (gen_random_uuid()::text,'SALES_LINE_AFTER_DISCOUNT','sales','LINE_AFTER_DISCOUNT','Sales Line After Discount','qty * unitPrice * (1 - discount / 100)','{"qty":"number","unitPrice":"number","discount":"number"}','Line amount after discount.'),
  (gen_random_uuid()::text,'SALES_LINE_TOTAL','sales','LINE_TOTAL','Sales Line Total','afterDiscount * (1 + tax / 100)','{"afterDiscount":"number","tax":"number"}','Line amount including tax.'),
  (gen_random_uuid()::text,'CAPACITY_LOAD_MINUTES','capacity','LOAD_MINUTES','Capacity Load Minutes','qty * cycleTimeMinutes / max(efficiencyPercent / 100, 0.000001)','{"qty":"number","cycleTimeMinutes":"number","efficiencyPercent":"number"}','Required capacity minutes.')
ON CONFLICT ("formula_code") DO NOTHING;
