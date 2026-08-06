UPDATE "tbl_machine"
SET "machine_family" = 'INSPECTION',
    "machine_technology" = 'MANUAL',
    "machine_specification_code" = 'INSPECTION-MANUAL',
    "machine_specification_name" = 'Manual Inspection & Packing'
WHERE "machine_code" = 'M-001'
  AND "is_deleted" = FALSE;

UPDATE "tbl_mbomprocess" route
SET "machine_specification_code" = 'SPOT_WELDING-RESISTANCE',
    "machine_id" = (
      SELECT machine."id" FROM "tbl_machine" machine
      WHERE machine."machine_specification_code" = 'SPOT_WELDING-RESISTANCE'
        AND machine."is_deleted" = FALSE
      ORDER BY CASE WHEN machine."status" = 'Active' THEN 0 ELSE 1 END, machine."machine_code"
      LIMIT 1
    ),
    "alternative_machine_ids" = '[]'::JSONB
FROM "tbl_process" process
WHERE route."process_id" = process."id"
  AND UPPER(process."process_code") LIKE '%SPOT%'
  AND route."is_deleted" = FALSE;

UPDATE "tbl_mbomprocess" route
SET "machine_specification_code" = 'ARC_WELDING-ARC',
    "machine_id" = (
      SELECT machine."id" FROM "tbl_machine" machine
      WHERE machine."machine_specification_code" = 'ARC_WELDING-ARC'
        AND machine."is_deleted" = FALSE
      ORDER BY CASE WHEN machine."status" = 'Active' THEN 0 ELSE 1 END, machine."machine_code"
      LIMIT 1
    ),
    "alternative_machine_ids" = '[]'::JSONB
FROM "tbl_process" process
WHERE route."process_id" = process."id"
  AND UPPER(process."process_code") LIKE '%WELD%'
  AND UPPER(process."process_code") NOT LIKE '%SPOT%'
  AND route."is_deleted" = FALSE;

UPDATE "tbl_mbomprocess" route
SET "machine_specification_code" = 'INSPECTION-MANUAL',
    "machine_id" = (
      SELECT machine."id" FROM "tbl_machine" machine
      WHERE machine."machine_specification_code" = 'INSPECTION-MANUAL'
        AND machine."is_deleted" = FALSE
      ORDER BY CASE WHEN machine."status" = 'Active' THEN 0 ELSE 1 END, machine."machine_code"
      LIMIT 1
    ),
    "alternative_machine_ids" = '[]'::JSONB
FROM "tbl_process" process
WHERE route."process_id" = process."id"
  AND (UPPER(process."process_code") LIKE '%INSP%' OR UPPER(process."process_code") LIKE '%PACK%')
  AND route."is_deleted" = FALSE;
