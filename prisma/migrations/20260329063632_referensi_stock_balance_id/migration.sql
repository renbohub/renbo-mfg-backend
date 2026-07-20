-- AlterTable
ALTER TABLE "tbl_stock_reservation" ADD COLUMN     "stock_balance_id" TEXT;

-- CreateIndex
CREATE INDEX "tbl_stock_reservation_stock_balance_id_idx" ON "tbl_stock_reservation"("stock_balance_id");

-- AddForeignKey
ALTER TABLE "tbl_stock_reservation" ADD CONSTRAINT "tbl_stock_reservation_stock_balance_id_fkey" FOREIGN KEY ("stock_balance_id") REFERENCES "tbl_stock_balance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
