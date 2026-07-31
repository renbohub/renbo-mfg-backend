-- Safe default approval rules for Purchasing.
-- They use page-level "approve" permission and remain configurable from
-- Approval Master. Self approval is enabled for the current compact role setup;
-- administrators can disable it after assigning dedicated approver roles.
WITH templates("rule_code", "rule_name", "page_code", "document_type", "description") AS (
  VALUES
    ('PURCHASING_PR_APPROVAL_DEFAULT', 'Purchase Requisition Approval', 'purchase-requisitions', 'PurchaseRequisition', 'Default central approval for Purchase Requisition.'),
    ('PURCHASING_PO_APPROVAL_DEFAULT', 'Purchase Order Approval', 'purchase-order', 'PurchaseOrder', 'Default central approval for Purchase Order.'),
    ('PURCHASING_INVOICE_APPROVAL_DEFAULT', 'Purchase Invoice Approval', 'purchase-invoices', 'PurchaseInvoice', 'Default central approval for Purchase Invoice.')
)
INSERT INTO "tbl_approval_rules" (
  "id", "rule_code", "rule_name", "module_code", "page_code", "action_code",
  "document_type", "description", "priority", "require_sequential",
  "allow_self_approval", "is_active", "is_deleted", "created_by", "updated_by",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text, t."rule_code", t."rule_name", 'purchasing',
  t."page_code", 'approve', t."document_type", t."description", 100, true,
  true, true, false, 'migration', 'migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM templates t
ON CONFLICT ("rule_code") DO UPDATE SET
  "rule_name" = EXCLUDED."rule_name",
  "module_code" = EXCLUDED."module_code",
  "page_code" = EXCLUDED."page_code",
  "action_code" = EXCLUDED."action_code",
  "document_type" = EXCLUDED."document_type",
  "is_active" = true,
  "is_deleted" = false,
  "updated_by" = 'migration',
  "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "tbl_approval_rule_steps" (
  "id", "approval_rule_id", "step_order", "step_name", "approver_role_id",
  "permission_action", "required_approvals", "pending_status", "approved_status",
  "rejected_status", "can_delegate", "is_active", "is_deleted", "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::text, rule."id", 1, 'Purchasing Approval', NULL,
  'approve', 1, 'Submitted', 'Approved', 'Rejected', true, true, false,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tbl_approval_rules" rule
WHERE rule."rule_code" IN (
  'PURCHASING_PR_APPROVAL_DEFAULT',
  'PURCHASING_PO_APPROVAL_DEFAULT',
  'PURCHASING_INVOICE_APPROVAL_DEFAULT'
)
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
