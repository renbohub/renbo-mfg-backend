-- Normalize the default PR approval rule to the actual Purchase Requisition
-- lifecycle. Custom free-text labels previously made documents appear to use
-- statuses that the PR workflow, filters, and reports do not recognize.
UPDATE "tbl_approval_rule_steps" step
SET
  "pending_status" = 'Submitted',
  "approved_status" = 'Approved',
  "rejected_status" = 'Rejected',
  "updated_at" = CURRENT_TIMESTAMP
FROM "tbl_approval_rules" rule
WHERE step."approval_rule_id" = rule."id"
  AND rule."rule_code" = 'PURCHASING_PR_APPROVAL_DEFAULT'
  AND rule."is_deleted" = false
  AND step."is_deleted" = false;
