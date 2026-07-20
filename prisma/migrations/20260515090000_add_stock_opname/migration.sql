-- CreateTable
CREATE TABLE "tbl_sto_headers" (
    "id" TEXT NOT NULL,
    "sto_no" TEXT NOT NULL,
    "sto_type" TEXT NOT NULL,
    "warehouse_code" TEXT NOT NULL,
    "sto_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "inventory_frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "checker_by" TEXT,
    "checker_approved_at" TIMESTAMP(3),
    "supervisor_approved_by" TEXT,
    "supervisor_approved_at" TIMESTAMP(3),
    "inventory_approved_by" TEXT,
    "inventory_approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "adjusted_by" TEXT,
    "adjusted_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_sto_headers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_sto_details" (
    "id" TEXT NOT NULL,
    "sto_header_id" TEXT NOT NULL,
    "stock_balance_id" TEXT,
    "part_code" TEXT,
    "part_number" TEXT,
    "part_name" TEXT,
    "product_id" TEXT,
    "description" TEXT,
    "spec" TEXT,
    "thickness" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "CSP" TEXT,
    "stock_type" TEXT,
    "warehouse_code" TEXT NOT NULL,
    "rack_code" TEXT,
    "lot_number" TEXT,
    "uom_code" TEXT,
    "system_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_qty" DOUBLE PRECISION,
    "variance_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "variance_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "variance_status" TEXT NOT NULL DEFAULT 'MATCH',
    "reason" TEXT,
    "counted_by" TEXT,
    "counted_at" TIMESTAMP(3),
    "adjustment_number" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_sto_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_sto_headers_sto_no_key" ON "tbl_sto_headers"("sto_no");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_sto_no_idx" ON "tbl_sto_headers"("sto_no");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_sto_type_idx" ON "tbl_sto_headers"("sto_type");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_warehouse_code_idx" ON "tbl_sto_headers"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_sto_date_idx" ON "tbl_sto_headers"("sto_date");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_status_idx" ON "tbl_sto_headers"("status");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_created_by_idx" ON "tbl_sto_headers"("created_by");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_approved_by_idx" ON "tbl_sto_headers"("approved_by");

-- CreateIndex
CREATE INDEX "tbl_sto_headers_is_deleted_idx" ON "tbl_sto_headers"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_sto_details_sto_header_id_idx" ON "tbl_sto_details"("sto_header_id");

-- CreateIndex
CREATE INDEX "tbl_sto_details_stock_balance_id_idx" ON "tbl_sto_details"("stock_balance_id");

-- CreateIndex
CREATE INDEX "tbl_sto_details_warehouse_code_idx" ON "tbl_sto_details"("warehouse_code");

-- CreateIndex
CREATE INDEX "tbl_sto_details_rack_code_idx" ON "tbl_sto_details"("rack_code");

-- CreateIndex
CREATE INDEX "tbl_sto_details_lot_number_idx" ON "tbl_sto_details"("lot_number");

-- CreateIndex
CREATE INDEX "tbl_sto_details_part_code_idx" ON "tbl_sto_details"("part_code");

-- CreateIndex
CREATE INDEX "tbl_sto_details_part_number_idx" ON "tbl_sto_details"("part_number");

-- CreateIndex
CREATE INDEX "tbl_sto_details_product_id_idx" ON "tbl_sto_details"("product_id");

-- CreateIndex
CREATE INDEX "tbl_sto_details_stock_type_idx" ON "tbl_sto_details"("stock_type");

-- CreateIndex
CREATE INDEX "tbl_sto_details_variance_status_idx" ON "tbl_sto_details"("variance_status");

-- CreateIndex
CREATE INDEX "tbl_sto_details_counted_by_idx" ON "tbl_sto_details"("counted_by");

-- CreateIndex
CREATE INDEX "tbl_sto_details_is_deleted_idx" ON "tbl_sto_details"("is_deleted");

-- AddForeignKey
ALTER TABLE "tbl_sto_headers" ADD CONSTRAINT "tbl_sto_headers_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_sto_details" ADD CONSTRAINT "tbl_sto_details_sto_header_id_fkey" FOREIGN KEY ("sto_header_id") REFERENCES "tbl_sto_headers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_sto_details" ADD CONSTRAINT "tbl_sto_details_stock_balance_id_fkey" FOREIGN KEY ("stock_balance_id") REFERENCES "tbl_stock_balance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_sto_details" ADD CONSTRAINT "tbl_sto_details_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_sto_details" ADD CONSTRAINT "tbl_sto_details_rack_code_fkey" FOREIGN KEY ("rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_sto_details" ADD CONSTRAINT "tbl_sto_details_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "tbl_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
