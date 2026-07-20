-- DropForeignKey
ALTER TABLE "tbl_work_order" DROP CONSTRAINT "tbl_work_order_work_center_code_fkey";

-- AlterTable
ALTER TABLE "tbl_work_order" ADD COLUMN     "work_center_id" TEXT;

-- CreateIndex
CREATE INDEX "tbl_work_order_work_center_id_idx" ON "tbl_work_order"("work_center_id");

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "tbl_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;
