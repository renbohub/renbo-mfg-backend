UPDATE "tbl_mrp_run"
SET "plan_number" = REPLACE("plan_number", 'MRP-MPS-MPS-', 'MRP-MPS-')
WHERE "plan_number" LIKE 'MRP-MPS-MPS-%';

UPDATE "tbl_planned_order"
SET "reference_number" = REPLACE("reference_number", 'MRP-MPS-MPS-', 'MRP-MPS-')
WHERE "reference_type" = 'MRP'
  AND "reference_number" LIKE 'MRP-MPS-MPS-%';
