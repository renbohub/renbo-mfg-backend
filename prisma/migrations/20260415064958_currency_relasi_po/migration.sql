-- AddForeignKey
ALTER TABLE "tbl_purchase_order" ADD CONSTRAINT "tbl_purchase_order_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "tbl_currency"("currency_code") ON DELETE RESTRICT ON UPDATE CASCADE;
