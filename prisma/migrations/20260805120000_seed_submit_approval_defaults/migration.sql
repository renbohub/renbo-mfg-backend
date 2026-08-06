-- Every business workflow that exposes an explicit Submit action must have an
-- active approval rule. The application blocks submit when a matching rule is
-- missing, so these defaults keep the standard workflows operational while
-- remaining editable from Master Data > Approval Rules.
WITH templates("rule_code", "rule_name", "module_code", "page_code", "document_type", "description", "pending_status") AS (
  VALUES
    ('SALES_FORECAST_APPROVAL_DEFAULT', 'Sales Forecast Approval', 'sales', 'forecasts', 'Forecast', 'Default central approval for submitted Sales Forecast.', 'Submitted'),
    ('PRODUCTION_LOG_APPROVAL_DEFAULT', 'Production Log Approval', 'production', 'production-logs', 'ProductionLog', 'Default central approval for submitted Production Log.', 'Submitted'),
    ('INVENTORY_STOCK_OPNAME_APPROVAL_DEFAULT', 'Stock Opname Approval', 'inventory', 'stock-opname', 'StockOpnameHeader', 'Default central approval for submitted Stock Opname counting.', 'WAITING_APPROVAL')
)
INSERT INTO "tbl_approval_rules" (
  "id", "rule_code", "rule_name", "module_code", "page_code", "action_code",
  "document_type", "description", "priority", "require_sequential",
  "allow_self_approval", "is_active", "is_deleted", "created_by", "updated_by",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text, t."rule_code", t."rule_name", t."module_code",
  t."page_code", 'approve', t."document_type", t."description", 100, true,
  true, true, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM templates t
ON CONFLICT ("rule_code") DO UPDATE SET
  "rule_name" = EXCLUDED."rule_name",
  "module_code" = EXCLUDED."module_code",
  "page_code" = EXCLUDED."page_code",
  "action_code" = EXCLUDED."action_code",
  "document_type" = EXCLUDED."document_type",
  "description" = EXCLUDED."description",
  "is_active" = true,
  "is_deleted" = false,
  "updated_by" = 'migration',
  "updated_at" = CURRENT_TIMESTAMP;

WITH templates("rule_code", "pending_status") AS (
  VALUES
    ('SALES_FORECAST_APPROVAL_DEFAULT', 'Submitted'),
    ('PRODUCTION_LOG_APPROVAL_DEFAULT', 'Submitted'),
    ('INVENTORY_STOCK_OPNAME_APPROVAL_DEFAULT', 'WAITING_APPROVAL')
)
INSERT INTO "tbl_approval_rule_steps" (
  "id", "approval_rule_id", "step_order", "step_name", "approver_role_id",
  "permission_action", "required_approvals", "pending_status", "approved_status",
  "rejected_status", "can_delegate", "is_active", "is_deleted", "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text, rule."id", 1, 'Document Approval', NULL,
  'approve', 1, t."pending_status", 'Approved', 'Rejected', true, true, false,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM templates t
JOIN "tbl_approval_rules" rule ON rule."rule_code" = t."rule_code"
ON CONFLICT ("approval_rule_id", "step_order") DO UPDATE SET
  "step_name" = EXCLUDED."step_name",
  "permission_action" = EXCLUDED."permission_action",
  "required_approvals" = EXCLUDED."required_approvals",
  "pending_status" = EXCLUDED."pending_status",
  "approved_status" = EXCLUDED."approved_status",
  "rejected_status" = EXCLUDED."rejected_status",
  "can_delegate" = EXCLUDED."can_delegate",
  "is_active" = true,
  "is_deleted" = false,
  "updated_at" = CURRENT_TIMESTAMP;
