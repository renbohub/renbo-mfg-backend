/*
  Warnings:

  - You are about to drop the column `machine_code` on the `tbl_work_order` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "tbl_work_order_machine_code_idx";

-- AlterTable
ALTER TABLE "tbl_work_order" DROP COLUMN "machine_code",
ADD COLUMN     "machine_id" TEXT;

-- CreateIndex
CREATE INDEX "tbl_work_order_machine_id_idx" ON "tbl_work_order"("machine_id");

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
