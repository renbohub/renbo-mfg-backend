UPDATE "tbl_stock_balance"
SET "thickness" = NULL
WHERE "thickness" = 0;

UPDATE "tbl_stock_balance"
SET "width" = NULL
WHERE "width" = 0;

UPDATE "tbl_stock_movement"
SET "thickness" = NULL
WHERE "thickness" = 0;

UPDATE "tbl_stock_movement"
SET "width" = NULL
WHERE "width" = 0;

UPDATE "tbl_stock_reservation"
SET "thickness" = NULL
WHERE "thickness" = 0;

UPDATE "tbl_stock_reservation"
SET "width" = NULL
WHERE "width" = 0;

UPDATE "tbl_purchase_requisition_detail"
SET "thickness" = NULL
WHERE "thickness" = 0;

UPDATE "tbl_purchase_requisition_detail"
SET "width" = NULL
WHERE "width" = 0;

UPDATE "tbl_purchase_order_detail"
SET "thickness" = NULL
WHERE "thickness" = 0;

UPDATE "tbl_purchase_order_detail"
SET "width" = NULL
WHERE "width" = 0;

UPDATE "tbl_part_base"
SET "thickness" = NULL
WHERE "thickness" = 0;

UPDATE "tbl_part_base"
SET "width" = NULL
WHERE "width" = 0;
