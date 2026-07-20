-- Add purchase invoice documents for supplier/vendor AP matching.
CREATE TABLE "tbl_purchase_invoice" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "supplier_invoice_number" TEXT NOT NULL,
    "invoice_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" TIMESTAMP(3),
    "po_number" TEXT NOT NULL,
    "supplier_code" TEXT,
    "supplier_name" TEXT,
    "vendor_code" TEXT,
    "vendor_name" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'IDR',
    "subtotal_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tax_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "match_status" TEXT NOT NULL DEFAULT 'Unchecked',
    "invoice_files" JSONB,
    "notes" TEXT,
    "created_by" TEXT,
    "submitted_by" TEXT,
    "submitted_date" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_date" TIMESTAMP(3),
    "paid_by" TEXT,
    "paid_date" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_purchase_invoice_detail" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "po_detail_id" TEXT NOT NULL,
    "gr_detail_id" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "spec" TEXT,
    "thickness" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "CSP" TEXT,
    "qty_invoiced" DOUBLE PRECISION NOT NULL,
    "uom_code" TEXT,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discount_type" TEXT NOT NULL DEFAULT 'percent',
    "tax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "variance_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_purchase_invoice_detail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_purchase_invoice_invoice_number_key" ON "tbl_purchase_invoice"("invoice_number");
CREATE INDEX "tbl_purchase_invoice_invoice_number_idx" ON "tbl_purchase_invoice"("invoice_number");
CREATE INDEX "tbl_purchase_invoice_supplier_invoice_number_idx" ON "tbl_purchase_invoice"("supplier_invoice_number");
CREATE INDEX "tbl_purchase_invoice_invoice_date_idx" ON "tbl_purchase_invoice"("invoice_date");
CREATE INDEX "tbl_purchase_invoice_due_date_idx" ON "tbl_purchase_invoice"("due_date");
CREATE INDEX "tbl_purchase_invoice_po_number_idx" ON "tbl_purchase_invoice"("po_number");
CREATE INDEX "tbl_purchase_invoice_supplier_code_idx" ON "tbl_purchase_invoice"("supplier_code");
CREATE INDEX "tbl_purchase_invoice_vendor_code_idx" ON "tbl_purchase_invoice"("vendor_code");
CREATE INDEX "tbl_purchase_invoice_currency_code_idx" ON "tbl_purchase_invoice"("currency_code");
CREATE INDEX "tbl_purchase_invoice_status_idx" ON "tbl_purchase_invoice"("status");
CREATE INDEX "tbl_purchase_invoice_match_status_idx" ON "tbl_purchase_invoice"("match_status");
CREATE INDEX "tbl_purchase_invoice_is_deleted_idx" ON "tbl_purchase_invoice"("is_deleted");

CREATE INDEX "tbl_purchase_invoice_detail_invoice_number_idx" ON "tbl_purchase_invoice_detail"("invoice_number");
CREATE INDEX "tbl_purchase_invoice_detail_po_detail_id_idx" ON "tbl_purchase_invoice_detail"("po_detail_id");
CREATE INDEX "tbl_purchase_invoice_detail_gr_detail_id_idx" ON "tbl_purchase_invoice_detail"("gr_detail_id");
CREATE INDEX "tbl_purchase_invoice_detail_product_id_idx" ON "tbl_purchase_invoice_detail"("product_id");
CREATE INDEX "tbl_purchase_invoice_detail_part_code_idx" ON "tbl_purchase_invoice_detail"("part_code");

ALTER TABLE "tbl_purchase_invoice" ADD CONSTRAINT "tbl_purchase_invoice_po_number_fkey" FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_purchase_invoice" ADD CONSTRAINT "tbl_purchase_invoice_supplier_code_fkey" FOREIGN KEY ("supplier_code") REFERENCES "tbl_supplier"("supplier_code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_purchase_invoice" ADD CONSTRAINT "tbl_purchase_invoice_vendor_code_fkey" FOREIGN KEY ("vendor_code") REFERENCES "tbl_vendor"("vendor_code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_purchase_invoice" ADD CONSTRAINT "tbl_purchase_invoice_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_purchase_invoice_detail" ADD CONSTRAINT "tbl_purchase_invoice_detail_invoice_number_fkey" FOREIGN KEY ("invoice_number") REFERENCES "tbl_purchase_invoice"("invoice_number") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_purchase_invoice_detail" ADD CONSTRAINT "tbl_purchase_invoice_detail_po_detail_id_fkey" FOREIGN KEY ("po_detail_id") REFERENCES "tbl_purchase_order_detail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_purchase_invoice_detail" ADD CONSTRAINT "tbl_purchase_invoice_detail_gr_detail_id_fkey" FOREIGN KEY ("gr_detail_id") REFERENCES "tbl_goods_receipt_detail"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_purchase_invoice_detail" ADD CONSTRAINT "tbl_purchase_invoice_detail_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
