-- Keep commercial order quantity separate from demand pegging.  A supplier
-- allocation may cover only the exact MRP demand while the ordered quantity
-- includes MOQ, order multiple, custom reserve, and free buffer.
ALTER TABLE "tbl_purchase_requisition_sourcing_allocation"
ADD COLUMN "commercial_qty" DOUBLE PRECISION;
