-- The initial example profile belongs to the MPS finished-good row only.
-- Remove profiles accidentally seeded onto same-part-number WIP stages by the
-- preceding migration; governed/manual profiles are deliberately untouched.
DELETE FROM "tbl_rccp_resource_profile" profile
USING "tbl_part" part
WHERE profile."part_id" = part."id"
  AND profile."source" = 'STEP_02_MPS_TO_RCCP'
  AND part."part_code" <> 'C002-C004-000';
