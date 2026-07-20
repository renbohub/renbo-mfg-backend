UPDATE "tbl_planned_order" po
SET
  "reference_type" = 'MRP',
  "reference_number" = mr."plan_number"
FROM "tbl_mrp_run" mr
WHERE po."run_number" = mr."run_number"
  AND mr."plan_number" IS NOT NULL
  AND po."reference_type" IN ('MRP', 'SO')
  AND (
    po."reference_number" IS NULL
    OR po."reference_number" = po."run_number"
    OR po."reference_number" LIKE 'MRP-%'
    OR po."reference_number" LIKE 'SO-%'
  );
