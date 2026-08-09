ALTER TABLE "tbl_purchase_suggestion_item"
ADD COLUMN "confirmed_material_length" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_suggestion_supplier_allocation"
ADD COLUMN "material_length" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_requisition_detail"
ADD COLUMN "material_length" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_requisition_sourcing_allocation"
ADD COLUMN "material_length" DOUBLE PRECISION;

ALTER TABLE "tbl_purchase_order_detail"
ADD COLUMN "material_length" DOUBLE PRECISION;
