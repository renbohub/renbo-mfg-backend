UPDATE "tbl_planned_order" po
SET "part_id" = p."id"
FROM "tbl_part" p
WHERE po."part_id" IS NULL
  AND po."part_code" = p."part_code"
  AND p."is_deleted" = false;
