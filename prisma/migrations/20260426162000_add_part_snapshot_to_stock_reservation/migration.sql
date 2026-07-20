ALTER TABLE "tbl_stock_reservation"
ADD COLUMN "part_number" TEXT,
ADD COLUMN "part_name" TEXT;

UPDATE "tbl_stock_reservation" sr
SET
  "part_number" = sb."part_number",
  "part_name" = sb."part_name"
FROM "tbl_stock_balance" sb
WHERE sr."stock_balance_id" = sb."id"
  AND (sr."part_number" IS NULL OR sr."part_name" IS NULL);

CREATE INDEX "tbl_stock_reservation_part_number_idx" ON "tbl_stock_reservation"("part_number");
CREATE INDEX "tbl_stock_reservation_part_name_idx" ON "tbl_stock_reservation"("part_name");
