-- CreateTable
CREATE TABLE "tbl_incoming_inspection" (
    "id" TEXT NOT NULL,
    "inspection_number" TEXT NOT NULL,
    "inspection_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gr_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "decision" TEXT NOT NULL DEFAULT 'Pending',
    "inspected_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_incoming_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbl_incoming_inspection_detail" (
    "id" TEXT NOT NULL,
    "inspection_id" TEXT NOT NULL,
    "gr_detail_id" TEXT NOT NULL,
    "line_number" INTEGER NOT NULL,
    "qty_inspected" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_accepted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_rejected" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_rework" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disposition" TEXT,
    "defect_code" TEXT,
    "defect_category" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_incoming_inspection_detail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_incoming_inspection_inspection_number_key" ON "tbl_incoming_inspection"("inspection_number");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_inspection_number_idx" ON "tbl_incoming_inspection"("inspection_number");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_gr_number_idx" ON "tbl_incoming_inspection"("gr_number");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_status_idx" ON "tbl_incoming_inspection"("status");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_decision_idx" ON "tbl_incoming_inspection"("decision");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_is_deleted_idx" ON "tbl_incoming_inspection"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_detail_inspection_id_idx" ON "tbl_incoming_inspection_detail"("inspection_id");

-- CreateIndex
CREATE INDEX "tbl_incoming_inspection_detail_gr_detail_id_idx" ON "tbl_incoming_inspection_detail"("gr_detail_id");

-- AddForeignKey
ALTER TABLE "tbl_incoming_inspection" ADD CONSTRAINT "tbl_incoming_inspection_gr_number_fkey" FOREIGN KEY ("gr_number") REFERENCES "tbl_goods_receipt"("gr_number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_incoming_inspection_detail" ADD CONSTRAINT "tbl_incoming_inspection_detail_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "tbl_incoming_inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_incoming_inspection_detail" ADD CONSTRAINT "tbl_incoming_inspection_detail_gr_detail_id_fkey" FOREIGN KEY ("gr_detail_id") REFERENCES "tbl_goods_receipt_detail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
