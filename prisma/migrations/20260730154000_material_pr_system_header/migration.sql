-- MRP remains on tbl_purchase_requisition_source. The material requisition
-- header itself is a system-consolidated Material Master demand document.
UPDATE "tbl_purchase_requisition"
SET "source_type" = 'SYSTEM'
WHERE "procurement_group" = 'MATERIAL'
  AND "source_type" = 'MRP';
