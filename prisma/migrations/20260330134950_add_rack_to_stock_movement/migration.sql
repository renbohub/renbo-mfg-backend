-- AlterTable: Tambah rack_code dan destination_rack_code ke tbl_stock_movement
ALTER TABLE "tbl_stock_movement" ADD COLUMN "rack_code" TEXT;
ALTER TABLE "tbl_stock_movement" ADD COLUMN "destination_rack_code" TEXT;

-- CreateIndex
CREATE INDEX "tbl_stock_movement_rack_code_idx" ON "tbl_stock_movement"("rack_code");
CREATE INDEX "tbl_stock_movement_destination_rack_code_idx" ON "tbl_stock_movement"("destination_rack_code");

-- AddForeignKey
ALTER TABLE "tbl_stock_movement" ADD CONSTRAINT "tbl_stock_movement_rack_code_fkey" FOREIGN KEY ("rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_stock_movement" ADD CONSTRAINT "tbl_stock_movement_destination_rack_code_fkey" FOREIGN KEY ("destination_rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;
