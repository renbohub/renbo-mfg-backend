/*
  Warnings:

  - You are about to drop the column `machine` on the `tbl_ebomprocess` table. All the data in the column will be lost.
  - You are about to drop the column `work_center` on the `tbl_ebomprocess` table. All the data in the column will be lost.
  - You are about to drop the column `machine` on the `tbl_mbomprocess` table. All the data in the column will be lost.
  - You are about to drop the column `work_center` on the `tbl_mbomprocess` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "tbl_ebomprocess" DROP COLUMN "machine",
DROP COLUMN "work_center",
ADD COLUMN     "machine_id" TEXT,
ADD COLUMN     "work_center_id" TEXT;

-- AlterTable
ALTER TABLE "tbl_mbomprocess" DROP COLUMN "machine",
DROP COLUMN "work_center",
ADD COLUMN     "machine_id" TEXT,
ADD COLUMN     "work_center_id" TEXT;

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_machine_id_idx" ON "tbl_ebomprocess"("machine_id");

-- CreateIndex
CREATE INDEX "tbl_ebomprocess_work_center_id_idx" ON "tbl_ebomprocess"("work_center_id");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_machine_id_idx" ON "tbl_mbomprocess"("machine_id");

-- CreateIndex
CREATE INDEX "tbl_mbomprocess_work_center_id_idx" ON "tbl_mbomprocess"("work_center_id");

-- AddForeignKey
ALTER TABLE "tbl_ebomprocess" ADD CONSTRAINT "tbl_ebomprocess_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_ebomprocess" ADD CONSTRAINT "tbl_ebomprocess_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "tbl_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "tbl_machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_mbomprocess" ADD CONSTRAINT "tbl_mbomprocess_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "tbl_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;
