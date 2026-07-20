-- Backfill legacy numeric master codes to prefixed codes:
-- Customer 001 -> C001, Supplier 001 -> S001, Vendor 001 -> V001.
--
-- Run only after taking a database backup. The script is idempotent for rows
-- that already have a prefix because it only maps codes matching digits only.

BEGIN;

CREATE TEMP TABLE _customer_code_map AS
SELECT customer_code AS old_code, 'C' || customer_code AS new_code
FROM tbl_customer
WHERE customer_code ~ '^[0-9]+$';

CREATE TEMP TABLE _supplier_code_map AS
SELECT supplier_code AS old_code, 'S' || supplier_code AS new_code
FROM tbl_supplier
WHERE supplier_code ~ '^[0-9]+$';

CREATE TEMP TABLE _vendor_code_map AS
SELECT vendor_code AS old_code, 'V' || vendor_code AS new_code
FROM tbl_vendor
WHERE vendor_code ~ '^[0-9]+$';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM _customer_code_map m
    JOIN tbl_customer c ON c.customer_code = m.new_code
  ) THEN
    RAISE EXCEPTION 'Customer code collision detected. Review numeric and prefixed customer codes before running backfill.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _supplier_code_map m
    JOIN tbl_supplier s ON s.supplier_code = m.new_code
  ) THEN
    RAISE EXCEPTION 'Supplier code collision detected. Review numeric and prefixed supplier codes before running backfill.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _vendor_code_map m
    JOIN tbl_vendor v ON v.vendor_code = m.new_code
  ) THEN
    RAISE EXCEPTION 'Vendor code collision detected. Review numeric and prefixed vendor codes before running backfill.';
  END IF;
END $$;

-- Master updates first. FK-backed transaction tables with ON UPDATE CASCADE
-- follow automatically: quotations, sales orders, purchase orders, invoices.
UPDATE tbl_customer c
SET customer_code = m.new_code
FROM _customer_code_map m
WHERE c.customer_code = m.old_code;

UPDATE tbl_supplier s
SET supplier_code = m.new_code
FROM _supplier_code_map m
WHERE s.supplier_code = m.old_code;

UPDATE tbl_vendor v
SET vendor_code = m.new_code
FROM _vendor_code_map m
WHERE v.vendor_code = m.old_code;

-- Customer code copies without FK cascade.
UPDATE tbl_part p
SET customer_code = m.new_code
FROM _customer_code_map m
WHERE p.customer_code = m.old_code;

UPDATE tbl_part p
SET customer_codes = mapped.customer_codes
FROM (
  SELECT
    p.id,
    array_agg(COALESCE(m.new_code, u.code) ORDER BY u.ordinality) AS customer_codes
  FROM tbl_part p
  CROSS JOIN LATERAL unnest(p.customer_codes) WITH ORDINALITY AS u(code, ordinality)
  LEFT JOIN _customer_code_map m ON m.old_code = u.code
  GROUP BY p.id
) mapped
WHERE p.id = mapped.id
  AND p.customer_codes IS DISTINCT FROM mapped.customer_codes;

UPDATE tbl_dies d
SET customer_code = m.new_code
FROM _customer_code_map m
WHERE d.customer_code = m.old_code;

UPDATE tbl_forecast f
SET customer_code = m.new_code
FROM _customer_code_map m
WHERE f.customer_code = m.old_code;

UPDATE tbl_mps_detail md
SET customer_code = m.new_code
FROM _customer_code_map m
WHERE md.customer_code = m.old_code;

-- Supplier/vendor code copies without FK cascade.
UPDATE tbl_planned_order po
SET supplier_code = m.new_code
FROM _supplier_code_map m
WHERE po.supplier_code = m.old_code;

UPDATE tbl_planned_order po
SET vendor_code = m.new_code
FROM _vendor_code_map m
WHERE po.vendor_code = m.old_code;

UPDATE tbl_purchase_requisition_detail prd
SET preferred_supplier = m.new_code
FROM _supplier_code_map m
WHERE prd.preferred_supplier = m.old_code;

UPDATE tbl_purchase_requisition_detail prd
SET preferred_vendor = m.new_code
FROM _vendor_code_map m
WHERE prd.preferred_vendor = m.old_code;

UPDATE tbl_dies_maintenance dm
SET vendor_code = m.new_code
FROM _vendor_code_map m
WHERE dm.vendor_code = m.old_code;

UPDATE tbl_vendor_process_order vpo
SET vendor_code = m.new_code
FROM _vendor_code_map m
WHERE vpo.vendor_code = m.old_code;

COMMIT;
