/*
  Warnings:

  - You are about to drop the `tbl_system_settings` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[warehouse_code,rack_code,lot_number,part_code,product_id,description,spec,thickness,width,CSP,part_number]` on the table `tbl_stock_balance` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "tbl_stock_balance_wh_rack_lot_identity_key";

-- AlterTable
ALTER TABLE "tbl_stock_balance" ADD COLUMN     "CSP" TEXT,
ADD COLUMN     "spec" TEXT,
ADD COLUMN     "thickness" DOUBLE PRECISION,
ADD COLUMN     "width" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "tbl_stock_movement" ADD COLUMN     "CSP" TEXT,
ADD COLUMN     "spec" TEXT,
ADD COLUMN     "thickness" DOUBLE PRECISION,
ADD COLUMN     "width" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "tbl_stock_reservation" ADD COLUMN     "CSP" TEXT,
ADD COLUMN     "spec" TEXT,
ADD COLUMN     "thickness" DOUBLE PRECISION,
ADD COLUMN     "width" DOUBLE PRECISION;

-- DropTable
DROP TABLE "tbl_system_settings";

-- CreateIndex
CREATE UNIQUE INDEX "tbl_stock_balance_wh_rack_lot_identity_key" ON "tbl_stock_balance"("warehouse_code", "rack_code", "lot_number", "part_code", "product_id", "description", "spec", "thickness", "width", "CSP", "part_number");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_spec_idx" ON "tbl_stock_movement"("spec");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_thickness_idx" ON "tbl_stock_movement"("thickness");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_width_idx" ON "tbl_stock_movement"("width");

-- CreateIndex
CREATE INDEX "tbl_stock_movement_CSP_idx" ON "tbl_stock_movement"("CSP");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_spec_idx" ON "tbl_stock_reservation"("spec");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_thickness_idx" ON "tbl_stock_reservation"("thickness");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_width_idx" ON "tbl_stock_reservation"("width");

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_CSP_idx" ON "tbl_stock_reservation"("CSP");

-- RenameIndex
ALTER INDEX "tbl_bom_relation_parent_item_id_child_item_id_mbom_header_id_ke" RENAME TO "tbl_bom_relation_parent_item_id_child_item_id_mbom_header_i_key";
