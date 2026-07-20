-- AlterTable
ALTER TABLE "tbl_purchase_requisition_detail" ADD COLUMN     "preferred_vendor" TEXT;

-- CreateIndex
CREATE INDEX "tbl_purchase_requisition_detail_preferred_vendor_idx" ON "tbl_purchase_requisition_detail"("preferred_vendor");
