-- Raw-material PR is identified by Material Master. The originating MRP
-- remains available through tbl_purchase_requisition_source.
WITH candidates AS (
  SELECT
    pr."id",
    TO_CHAR(pr."pr_date", 'YYYYMMDD') AS date_key,
    ROW_NUMBER() OVER (
      PARTITION BY TO_CHAR(pr."pr_date", 'YYYYMMDD')
      ORDER BY pr."created_at", pr."pr_number"
    ) AS sequence_no
  FROM "tbl_purchase_requisition" pr
  WHERE pr."procurement_group" = 'MATERIAL'
    AND pr."pr_number" LIKE 'PR-MRP-%'
),
existing AS (
  SELECT
    TO_CHAR(pr."pr_date", 'YYYYMMDD') AS date_key,
    MAX((REGEXP_MATCH(pr."pr_number", '([0-9]+)$'))[1]::INTEGER) AS last_sequence
  FROM "tbl_purchase_requisition" pr
  WHERE pr."procurement_group" = 'MATERIAL'
    AND pr."pr_number" LIKE 'PR-MAT-%'
  GROUP BY TO_CHAR(pr."pr_date", 'YYYYMMDD')
),
renames AS (
  SELECT
    candidates."id",
    'PR-MAT-' || candidates.date_key || '-' ||
      LPAD((candidates.sequence_no + COALESCE(existing.last_sequence, 0))::TEXT, 3, '0') AS new_pr_number
  FROM candidates
  LEFT JOIN existing ON existing.date_key = candidates.date_key
)
UPDATE "tbl_purchase_requisition" pr
SET "pr_number" = renames.new_pr_number
FROM renames
WHERE pr."id" = renames."id";
