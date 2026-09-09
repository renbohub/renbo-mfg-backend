-- AlterTable
ALTER TABLE "tbl_salesorderheader" ADD COLUMN     "customer_po_number" TEXT;

-- AlterTable
ALTER TABLE "tbl_incoming_inspection_detail" ADD COLUMN     "checklist" JSONB;

-- CreateTable
CREATE TABLE "tbl_inventory_reorder_state" (
    "stock_balance_id" TEXT NOT NULL,
    "is_low" BOOLEAN NOT NULL DEFAULT false,
    "notified_user_ids" JSONB NOT NULL DEFAULT '[]',
    "last_available" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_inventory_reorder_state_pkey" PRIMARY KEY ("stock_balance_id")
);

-- CreateTable
CREATE TABLE "tbl_partner_access" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "supplier_code" TEXT,
    "vendor_code" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "managed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_partner_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_partner_delivery_notice" (
    "id" TEXT NOT NULL,
    "notice_number" TEXT NOT NULL,
    "partner_access_id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "delivery_note_number" TEXT NOT NULL,
    "expected_date" TIMESTAMP(3) NOT NULL,
    "details" JSONB NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Submitted',
    "gr_number" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_partner_delivery_notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_incoming_document" (
    "id" TEXT NOT NULL,
    "notice_id" TEXT,
    "gr_number" TEXT,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_incoming_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_partner_access_user_id_key" ON "tbl_partner_access"("user_id");

-- CreateIndex
CREATE INDEX "tbl_partner_access_supplier_code_idx" ON "tbl_partner_access"("supplier_code");

-- CreateIndex
CREATE INDEX "tbl_partner_access_vendor_code_idx" ON "tbl_partner_access"("vendor_code");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_partner_delivery_notice_notice_number_key" ON "tbl_partner_delivery_notice"("notice_number");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_partner_delivery_notice_gr_number_key" ON "tbl_partner_delivery_notice"("gr_number");

-- CreateIndex
CREATE INDEX "tbl_partner_delivery_notice_po_number_status_idx" ON "tbl_partner_delivery_notice"("po_number", "status");

-- CreateIndex
CREATE INDEX "tbl_partner_delivery_notice_expected_date_idx" ON "tbl_partner_delivery_notice"("expected_date");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_partner_delivery_notice_partner_access_id_po_number_del_key" ON "tbl_partner_delivery_notice"("partner_access_id", "po_number", "delivery_note_number");

-- CreateIndex
CREATE UNIQUE INDEX "tbl_incoming_document_storage_key_key" ON "tbl_incoming_document"("storage_key");

-- CreateIndex
CREATE INDEX "tbl_incoming_document_notice_id_idx" ON "tbl_incoming_document"("notice_id");

-- CreateIndex
CREATE INDEX "tbl_incoming_document_gr_number_idx" ON "tbl_incoming_document"("gr_number");

-- AddForeignKey
ALTER TABLE "tbl_inventory_reorder_state" ADD CONSTRAINT "tbl_inventory_reorder_state_stock_balance_id_fkey" FOREIGN KEY ("stock_balance_id") REFERENCES "tbl_stock_balance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_partner_access" ADD CONSTRAINT "tbl_partner_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tbl_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_partner_access" ADD CONSTRAINT "tbl_partner_access_supplier_code_fkey" FOREIGN KEY ("supplier_code") REFERENCES "tbl_supplier"("supplier_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_partner_access" ADD CONSTRAINT "tbl_partner_access_vendor_code_fkey" FOREIGN KEY ("vendor_code") REFERENCES "tbl_vendor"("vendor_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_partner_delivery_notice" ADD CONSTRAINT "tbl_partner_delivery_notice_partner_access_id_fkey" FOREIGN KEY ("partner_access_id") REFERENCES "tbl_partner_access"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_partner_delivery_notice" ADD CONSTRAINT "tbl_partner_delivery_notice_po_number_fkey" FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_partner_delivery_notice" ADD CONSTRAINT "tbl_partner_delivery_notice_gr_number_fkey" FOREIGN KEY ("gr_number") REFERENCES "tbl_goods_receipt"("gr_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_incoming_document" ADD CONSTRAINT "tbl_incoming_document_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "tbl_partner_delivery_notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_incoming_document" ADD CONSTRAINT "tbl_incoming_document_gr_number_fkey" FOREIGN KEY ("gr_number") REFERENCES "tbl_goods_receipt"("gr_number") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_partner_access" ADD CONSTRAINT "partner_exactly_one_party" CHECK ((supplier_code IS NOT NULL)::int + (vendor_code IS NOT NULL)::int = 1);
ALTER TABLE "tbl_incoming_document" ADD CONSTRAINT "incoming_document_exactly_one_parent" CHECK ((notice_id IS NOT NULL)::int + (gr_number IS NOT NULL)::int = 1);