-- CreateTable
CREATE TABLE "tbl_purchase_order_comments" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'revision',
    "message" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "created_by" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tbl_purchase_order_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tbl_purchase_order_comments_po_number_idx" ON "tbl_purchase_order_comments"("po_number");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_comments_type_idx" ON "tbl_purchase_order_comments"("type");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_comments_created_by_idx" ON "tbl_purchase_order_comments"("created_by");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_comments_user_id_idx" ON "tbl_purchase_order_comments"("user_id");

-- CreateIndex
CREATE INDEX "tbl_purchase_order_comments_created_at_idx" ON "tbl_purchase_order_comments"("created_at");

-- AddForeignKey
ALTER TABLE "tbl_purchase_order_comments" ADD CONSTRAINT "tbl_purchase_order_comments_po_number_fkey" FOREIGN KEY ("po_number") REFERENCES "tbl_purchase_order"("po_number") ON DELETE CASCADE ON UPDATE CASCADE;
