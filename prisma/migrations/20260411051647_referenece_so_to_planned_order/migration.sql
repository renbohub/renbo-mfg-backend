-- AlterTable
ALTER TABLE "tbl_planned_order" ADD COLUMN     "reference_number" TEXT,
ADD COLUMN     "reference_type" TEXT,
ALTER COLUMN "run_number" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "tbl_planned_order_reference_type_idx" ON "tbl_planned_order"("reference_type");

-- CreateIndex
CREATE INDEX "tbl_planned_order_reference_number_idx" ON "tbl_planned_order"("reference_number");
