-- Additive procurement planning fields. Existing MRP/PR records remain valid.
ALTER TABLE "tbl_planned_order"
  ADD COLUMN IF NOT EXISTS "supplier_proposal_source" TEXT,
  ADD COLUMN IF NOT EXISTS "lot_count" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "kg_per_lot" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "purchase_qty_kg" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lot_allocations" JSONB;

ALTER TABLE "tbl_purchase_requisition_detail"
  ADD COLUMN IF NOT EXISTS "proposed_supplier_code" TEXT,
  ADD COLUMN IF NOT EXISTS "confirmed_supplier_code" TEXT,
  ADD COLUMN IF NOT EXISTS "supplier_confirmed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "supplier_confirmed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "supplier_proposal_source" TEXT,
  ADD COLUMN IF NOT EXISTS "lot_count" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "kg_per_lot" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "purchase_qty_kg" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lot_allocations" JSONB;

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_detail_proposed_supplier_code_idx"
  ON "tbl_purchase_requisition_detail"("proposed_supplier_code");

CREATE INDEX IF NOT EXISTS "tbl_purchase_requisition_detail_confirmed_supplier_code_idx"
  ON "tbl_purchase_requisition_detail"("confirmed_supplier_code");

CREATE INDEX IF NOT EXISTS "tbl_planned_order_supplier_proposal_source_idx"
  ON "tbl_planned_order"("supplier_proposal_source");
