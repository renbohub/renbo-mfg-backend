INSERT INTO "tbl_roles" (
  "id", "role_code", "role_name", "description", "is_system", "is_active", "is_deleted", "created_by", "updated_by", "created_at", "updated_at"
)
VALUES (
  gen_random_uuid(), 'SYSTEM_ADMIN', 'System Administrator', 'Akses penuh seluruh module dan master konfigurasi sistem.', true, true, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("role_code") DO NOTHING;

INSERT INTO "tbl_role_permissions" (
  "id", "role_id", "module_code", "page_code", "resource_code", "actions", "is_active", "is_deleted", "created_by", "updated_by", "created_at", "updated_at"
)
SELECT gen_random_uuid(), r."id", '*', '*', '*', '["*"]'::jsonb, true, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tbl_roles" r
WHERE r."role_code" = 'SYSTEM_ADMIN'
ON CONFLICT ("role_id", "module_code", "page_code") DO UPDATE
SET "actions" = EXCLUDED."actions", "is_active" = true, "is_deleted" = false, "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "tbl_user_roles" (
  "id", "user_id", "role_id", "is_primary", "is_active", "assigned_by", "created_at", "updated_at"
)
SELECT gen_random_uuid(), u."id", r."id", true, true, 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tbl_users" u
CROSS JOIN "tbl_roles" r
WHERE u."is_super_admin" = true
  AND u."is_deleted" = false
  AND r."role_code" = 'SYSTEM_ADMIN'
ON CONFLICT ("user_id", "role_id") DO UPDATE
SET "is_primary" = true, "is_active" = true, "assigned_by" = 'migration', "updated_at" = CURRENT_TIMESTAMP;

WITH templates("rule_code", "rule_name", "module_code", "page_code", "document_type", "description") AS (
  VALUES
    ('PO_APPROVAL_TEMPLATE', 'Purchase Order Approval', 'purchasing', 'purchase-order', 'PurchaseOrder', 'Template approval Purchase Order. Aktifkan setelah role approver dan batas nilai dikonfigurasi.'),
    ('MPS_APPROVAL_TEMPLATE', 'MPS Confirmation Approval', 'planning-ppic', 'master-production-schedule', 'MPS', 'Template approval konfirmasi Master Production Schedule.'),
    ('MONTHLY_PLAN_APPROVAL_TEMPLATE', 'Monthly Production Plan Approval', 'planning-ppic', 'monthly-plan', 'MonthlyProductionPlan', 'Template approval Monthly Production Plan.'),
    ('PRODUCTION_LOG_APPROVAL_TEMPLATE', 'Production Log Approval', 'production', 'production-logs', 'ProductionLog', 'Template approval realisasi Production Log.'),
    ('MBOM_DRAFT_APPROVAL_TEMPLATE', 'MBOM Draft Approval', 'manufacturing-bom', 'bill-of-materials', 'MBOMDraft', 'Template approval draft MBOM sebelum menjadi BOM aktif.')
)
INSERT INTO "tbl_approval_rules" (
  "id", "rule_code", "rule_name", "module_code", "page_code", "action_code", "document_type", "description", "priority",
  "require_sequential", "allow_self_approval", "is_active", "is_deleted", "created_by", "updated_by", "created_at", "updated_at"
)
SELECT gen_random_uuid(), t."rule_code", t."rule_name", t."module_code", t."page_code", 'approve', t."document_type", t."description", 100,
       true, false, false, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM templates t
ON CONFLICT ("rule_code") DO NOTHING;

INSERT INTO "tbl_approval_rule_steps" (
  "id", "approval_rule_id", "step_order", "step_name", "approver_role_id", "permission_action", "required_approvals",
  "approved_status", "rejected_status", "is_active", "is_deleted", "created_at", "updated_at"
)
SELECT gen_random_uuid(), ar."id", 1, 'System Approval', r."id", 'approve', 1,
       'Approved', 'Rejected', true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tbl_approval_rules" ar
CROSS JOIN "tbl_roles" r
WHERE ar."rule_code" IN (
  'PO_APPROVAL_TEMPLATE',
  'MPS_APPROVAL_TEMPLATE',
  'MONTHLY_PLAN_APPROVAL_TEMPLATE',
  'PRODUCTION_LOG_APPROVAL_TEMPLATE',
  'MBOM_DRAFT_APPROVAL_TEMPLATE'
)
  AND r."role_code" = 'SYSTEM_ADMIN'
ON CONFLICT ("approval_rule_id", "step_order") DO NOTHING;
