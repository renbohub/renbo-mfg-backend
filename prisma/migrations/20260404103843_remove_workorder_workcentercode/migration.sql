/*
  Warnings:

  - You are about to drop the column `work_center_code` on the `tbl_work_order` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "tbl_work_order_work_center_code_idx";

-- AlterTable
ALTER TABLE "tbl_work_order" DROP COLUMN "work_center_code";
