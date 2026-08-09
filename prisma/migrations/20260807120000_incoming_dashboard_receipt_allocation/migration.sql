CREATE TABLE "tbl_goods_receipt_allocation" (
    "id" TEXT NOT NULL,
    "gr_detail_id" TEXT NOT NULL,
    "pr_source_id" TEXT,
    "allocation_type" TEXT NOT NULL DEFAULT 'DEMAND',
    "planned_order_number" TEXT,
    "part_code" TEXT,
    "fg_part_code" TEXT,
    "required_date" TIMESTAMP(3),
    "required_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allocated_qty" DOUBLE PRECISION NOT NULL,
    "uom_code" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_goods_receipt_allocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_goods_receipt_allocation_gr_detail_id_idx" ON "tbl_goods_receipt_allocation"("gr_detail_id");
CREATE INDEX "tbl_goods_receipt_allocation_pr_source_id_idx" ON "tbl_goods_receipt_allocation"("pr_source_id");
CREATE INDEX "tbl_goods_receipt_allocation_planned_order_number_idx" ON "tbl_goods_receipt_allocation"("planned_order_number");
CREATE INDEX "tbl_goods_receipt_allocation_part_code_idx" ON "tbl_goods_receipt_allocation"("part_code");
CREATE INDEX "tbl_goods_receipt_allocation_fg_part_code_idx" ON "tbl_goods_receipt_allocation"("fg_part_code");
CREATE INDEX "tbl_goods_receipt_allocation_required_date_idx" ON "tbl_goods_receipt_allocation"("required_date");
CREATE INDEX "tbl_goods_receipt_allocation_allocation_type_idx" ON "tbl_goods_receipt_allocation"("allocation_type");
CREATE INDEX "tbl_goods_receipt_allocation_is_deleted_idx" ON "tbl_goods_receipt_allocation"("is_deleted");

ALTER TABLE "tbl_goods_receipt_allocation"
ADD CONSTRAINT "tbl_goods_receipt_allocation_gr_detail_id_fkey"
FOREIGN KEY ("gr_detail_id") REFERENCES "tbl_goods_receipt_detail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_goods_receipt_allocation"
ADD CONSTRAINT "tbl_goods_receipt_allocation_pr_source_id_fkey"
FOREIGN KEY ("pr_source_id") REFERENCES "tbl_purchase_requisition_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
