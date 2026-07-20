CREATE TABLE "tbl_roles" (
  "id" TEXT NOT NULL,
  "role_code" TEXT NOT NULL,
  "role_name" TEXT NOT NULL,
  "description" TEXT,
  "is_system" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_by" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_user_roles" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "assigned_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_user_roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_role_permissions" (
  "id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "page_code" TEXT NOT NULL,
  "resource_code" TEXT,
  "actions" JSONB NOT NULL DEFAULT '[]',
  "data_scope" JSONB,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_by" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_approval_rules" (
  "id" TEXT NOT NULL,
  "rule_code" TEXT NOT NULL,
  "rule_name" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "page_code" TEXT NOT NULL,
  "action_code" TEXT NOT NULL DEFAULT 'approve',
  "document_type" TEXT,
  "description" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "min_amount" DOUBLE PRECISION,
  "max_amount" DOUBLE PRECISION,
  "currency_code" TEXT,
  "conditions" JSONB,
  "require_sequential" BOOLEAN NOT NULL DEFAULT true,
  "allow_self_approval" BOOLEAN NOT NULL DEFAULT false,
  "effective_from" TIMESTAMP(3),
  "effective_until" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_by" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_approval_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_approval_rule_steps" (
  "id" TEXT NOT NULL,
  "approval_rule_id" TEXT NOT NULL,
  "step_order" INTEGER NOT NULL,
  "step_name" TEXT NOT NULL,
  "approver_role_id" TEXT,
  "permission_action" TEXT NOT NULL DEFAULT 'approve',
  "required_approvals" INTEGER NOT NULL DEFAULT 1,
  "pending_status" TEXT,
  "approved_status" TEXT,
  "rejected_status" TEXT,
  "sla_hours" INTEGER,
  "can_delegate" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_approval_rule_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_approval_requests" (
  "id" TEXT NOT NULL,
  "request_number" TEXT NOT NULL,
  "approval_rule_id" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "page_code" TEXT NOT NULL,
  "action_code" TEXT NOT NULL DEFAULT 'approve',
  "document_type" TEXT,
  "document_id" TEXT NOT NULL,
  "document_number" TEXT,
  "amount" DOUBLE PRECISION,
  "currency_code" TEXT,
  "current_step" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "context" JSONB,
  "requested_by_user_id" TEXT,
  "requested_by" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_approval_actions" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "rule_step_id" TEXT,
  "step_order" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "acted_by_user_id" TEXT,
  "acted_by" TEXT,
  "notes" TEXT,
  "metadata" JSONB,
  "acted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_approval_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_roles_role_code_key" ON "tbl_roles"("role_code");
CREATE INDEX "tbl_roles_role_code_idx" ON "tbl_roles"("role_code");
CREATE INDEX "tbl_roles_is_active_idx" ON "tbl_roles"("is_active");
CREATE INDEX "tbl_roles_is_deleted_idx" ON "tbl_roles"("is_deleted");
CREATE UNIQUE INDEX "tbl_user_roles_user_id_role_id_key" ON "tbl_user_roles"("user_id", "role_id");
CREATE INDEX "tbl_user_roles_user_id_idx" ON "tbl_user_roles"("user_id");
CREATE INDEX "tbl_user_roles_role_id_idx" ON "tbl_user_roles"("role_id");
CREATE INDEX "tbl_user_roles_is_active_idx" ON "tbl_user_roles"("is_active");
CREATE UNIQUE INDEX "tbl_role_permissions_role_id_module_code_page_code_key" ON "tbl_role_permissions"("role_id", "module_code", "page_code");
CREATE INDEX "tbl_role_permissions_role_id_idx" ON "tbl_role_permissions"("role_id");
CREATE INDEX "tbl_role_permissions_module_code_page_code_idx" ON "tbl_role_permissions"("module_code", "page_code");
CREATE INDEX "tbl_role_permissions_resource_code_idx" ON "tbl_role_permissions"("resource_code");
CREATE INDEX "tbl_role_permissions_is_active_idx" ON "tbl_role_permissions"("is_active");
CREATE INDEX "tbl_role_permissions_is_deleted_idx" ON "tbl_role_permissions"("is_deleted");
CREATE UNIQUE INDEX "tbl_approval_rules_rule_code_key" ON "tbl_approval_rules"("rule_code");
CREATE INDEX "tbl_approval_rules_module_code_page_code_action_code_idx" ON "tbl_approval_rules"("module_code", "page_code", "action_code");
CREATE INDEX "tbl_approval_rules_priority_idx" ON "tbl_approval_rules"("priority");
CREATE INDEX "tbl_approval_rules_is_active_idx" ON "tbl_approval_rules"("is_active");
CREATE INDEX "tbl_approval_rules_is_deleted_idx" ON "tbl_approval_rules"("is_deleted");
CREATE UNIQUE INDEX "tbl_approval_rule_steps_approval_rule_id_step_order_key" ON "tbl_approval_rule_steps"("approval_rule_id", "step_order");
CREATE INDEX "tbl_approval_rule_steps_approval_rule_id_idx" ON "tbl_approval_rule_steps"("approval_rule_id");
CREATE INDEX "tbl_approval_rule_steps_approver_role_id_idx" ON "tbl_approval_rule_steps"("approver_role_id");
CREATE INDEX "tbl_approval_rule_steps_is_active_idx" ON "tbl_approval_rule_steps"("is_active");
CREATE INDEX "tbl_approval_rule_steps_is_deleted_idx" ON "tbl_approval_rule_steps"("is_deleted");
CREATE UNIQUE INDEX "tbl_approval_requests_request_number_key" ON "tbl_approval_requests"("request_number");
CREATE INDEX "tbl_approval_requests_approval_rule_id_idx" ON "tbl_approval_requests"("approval_rule_id");
CREATE INDEX "tbl_approval_requests_module_code_page_code_action_code_idx" ON "tbl_approval_requests"("module_code", "page_code", "action_code");
CREATE INDEX "tbl_approval_requests_module_page_action_document_deleted_idx" ON "tbl_approval_requests"("module_code", "page_code", "action_code", "document_id", "is_deleted");
CREATE INDEX "tbl_approval_requests_document_id_idx" ON "tbl_approval_requests"("document_id");
CREATE INDEX "tbl_approval_requests_status_idx" ON "tbl_approval_requests"("status");
CREATE INDEX "tbl_approval_requests_requested_by_user_id_idx" ON "tbl_approval_requests"("requested_by_user_id");
CREATE INDEX "tbl_approval_requests_is_deleted_idx" ON "tbl_approval_requests"("is_deleted");
CREATE UNIQUE INDEX "tbl_approval_requests_active_document_key" ON "tbl_approval_requests"("module_code", "page_code", "action_code", "document_id") WHERE "is_deleted" = false AND "status" IN ('Pending', 'In Approval');
CREATE INDEX "tbl_approval_actions_request_id_idx" ON "tbl_approval_actions"("request_id");
CREATE INDEX "tbl_approval_actions_rule_step_id_idx" ON "tbl_approval_actions"("rule_step_id");
CREATE INDEX "tbl_approval_actions_step_order_idx" ON "tbl_approval_actions"("step_order");
CREATE INDEX "tbl_approval_actions_action_idx" ON "tbl_approval_actions"("action");
CREATE INDEX "tbl_approval_actions_acted_by_user_id_idx" ON "tbl_approval_actions"("acted_by_user_id");

ALTER TABLE "tbl_user_roles" ADD CONSTRAINT "tbl_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "tbl_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_user_roles" ADD CONSTRAINT "tbl_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "tbl_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_role_permissions" ADD CONSTRAINT "tbl_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "tbl_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_approval_rule_steps" ADD CONSTRAINT "tbl_approval_rule_steps_approval_rule_id_fkey" FOREIGN KEY ("approval_rule_id") REFERENCES "tbl_approval_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_approval_rule_steps" ADD CONSTRAINT "tbl_approval_rule_steps_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "tbl_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_approval_requests" ADD CONSTRAINT "tbl_approval_requests_approval_rule_id_fkey" FOREIGN KEY ("approval_rule_id") REFERENCES "tbl_approval_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_approval_actions" ADD CONSTRAINT "tbl_approval_actions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "tbl_approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_approval_actions" ADD CONSTRAINT "tbl_approval_actions_rule_step_id_fkey" FOREIGN KEY ("rule_step_id") REFERENCES "tbl_approval_rule_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
