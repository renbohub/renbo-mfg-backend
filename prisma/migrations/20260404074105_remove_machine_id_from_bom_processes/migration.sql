/*
  Warnings:

  - You are about to drop the column `machine_id` on the `tbl_ebomprocess` table. All the data in the column will be lost.
  - You are about to drop the column `machine_id` on the `tbl_mbomprocess` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "tbl_ebomprocess" DROP CONSTRAINT "tbl_ebomprocess_machine_id_fkey";

-- DropForeignKey
ALTER TABLE "tbl_mbomprocess" DROP CONSTRAINT "tbl_mbomprocess_machine_id_fkey";

-- DropIndex
DROP INDEX "tbl_ebomprocess_machine_id_idx";

-- DropIndex
DROP INDEX "tbl_mbomprocess_machine_id_idx";

-- AlterTable
ALTER TABLE "tbl_ebomprocess" DROP COLUMN "machine_id";

-- AlterTable
ALTER TABLE "tbl_mbomprocess" DROP COLUMN "machine_id";
