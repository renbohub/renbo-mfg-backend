/*
  Warnings:

  - You are about to drop the column `machine_code` on the `tbl_work_center` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "tbl_work_center_machine_code_idx";

-- AlterTable
ALTER TABLE "tbl_machine" ADD COLUMN     "work_center_id" TEXT;

-- AlterTable
ALTER TABLE "tbl_work_center" DROP COLUMN "machine_code";

-- CreateIndex
CREATE INDEX "tbl_machine_work_center_id_idx" ON "tbl_machine"("work_center_id");

-- AddForeignKey
ALTER TABLE "tbl_machine" ADD CONSTRAINT "tbl_machine_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "tbl_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;
