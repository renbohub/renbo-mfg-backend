ALTER TABLE "tbl_material_issue_detail"
  ADD COLUMN "stock_balance_id" TEXT,
  ADD COLUMN "rack_code" TEXT;

CREATE INDEX "tbl_material_issue_detail_stock_balance_id_idx" ON "tbl_material_issue_detail"("stock_balance_id");
CREATE INDEX "tbl_material_issue_detail_rack_code_idx" ON "tbl_material_issue_detail"("rack_code");
