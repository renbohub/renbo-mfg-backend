ALTER TABLE "tbl_monthly_plan_recommendation_scenario"
  ADD COLUMN "generation_source" TEXT,
  ADD COLUMN "ai_request_id" TEXT,
  ADD COLUMN "model_profile_code" TEXT,
  ADD COLUMN "prompt_version" TEXT,
  ADD COLUMN "ai_validation_summary" JSONB;

CREATE INDEX "tbl_monthly_plan_recommendation_scenario_ai_request_id_idx"
  ON "tbl_monthly_plan_recommendation_scenario"("ai_request_id");
CREATE INDEX "tbl_monthly_plan_recommendation_scenario_generation_source_idx"
  ON "tbl_monthly_plan_recommendation_scenario"("generation_source");

CREATE TABLE "tbl_ai_model_profile" (
  "id" TEXT NOT NULL,
  "profile_code" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "model_family" TEXT NOT NULL,
  "gguf_file_name" TEXT NOT NULL,
  "sha256" TEXT,
  "quantization" TEXT NOT NULL,
  "prompt_compatibility_version" TEXT NOT NULL,
  "runtime_config" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "benchmark_result" JSONB,
  "rollback_profile_id" TEXT,
  "activated_by" TEXT,
  "activated_at" TIMESTAMP(3),
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_ai_model_profile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_ai_model_profile_profile_code_key"
  ON "tbl_ai_model_profile"("profile_code");
CREATE INDEX "tbl_ai_model_profile_status_idx"
  ON "tbl_ai_model_profile"("status");

CREATE TABLE "tbl_ai_conversation" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "page_code" TEXT NOT NULL,
  "record_key" TEXT,
  "title" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_ai_conversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_ai_conversation_user_id_status_last_message_at_idx"
  ON "tbl_ai_conversation"("user_id", "status", "last_message_at");
CREATE INDEX "tbl_ai_conversation_expires_at_idx"
  ON "tbl_ai_conversation"("expires_at");

CREATE TABLE "tbl_ai_message" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "citations" JSONB,
  "model_profile_id" TEXT,
  "prompt_version" TEXT,
  "runtime_metrics" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_ai_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_ai_message_conversation_id_created_at_idx"
  ON "tbl_ai_message"("conversation_id", "created_at");

CREATE TABLE "tbl_ai_request" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "user_message_id" TEXT NOT NULL,
  "assistant_message_id" TEXT,
  "model_profile_id" TEXT,
  "request_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "payload" JSONB NOT NULL,
  "error_code" TEXT,
  "error_message" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_ai_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_ai_request_status_priority_created_at_idx"
  ON "tbl_ai_request"("status", "priority", "created_at");
CREATE INDEX "tbl_ai_request_conversation_id_created_at_idx"
  ON "tbl_ai_request"("conversation_id", "created_at");

CREATE TABLE "tbl_ai_capability_call" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "capability_code" TEXT NOT NULL,
  "operation_class" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "request_data" JSONB NOT NULL,
  "response_data" JSONB,
  "permission_context" JSONB NOT NULL,
  "source_refs" JSONB,
  "error_code" TEXT,
  "duration_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_ai_capability_call_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_ai_capability_call_request_id_created_at_idx"
  ON "tbl_ai_capability_call"("request_id", "created_at");
CREATE INDEX "tbl_ai_capability_call_capability_code_created_at_idx"
  ON "tbl_ai_capability_call"("capability_code", "created_at");

CREATE TABLE "tbl_ai_draft" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "capability_call_id" TEXT,
  "user_id" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "page_code" TEXT NOT NULL,
  "draft_type" TEXT NOT NULL,
  "generation_source" TEXT NOT NULL DEFAULT 'AI_GENERATED',
  "status" TEXT NOT NULL DEFAULT 'WAITING_CONFIRMATION',
  "payload" JSONB NOT NULL,
  "source_refs" JSONB,
  "validation_summary" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "rejected_by" TEXT,
  "rejected_at" TIMESTAMP(3),
  "official_entity_type" TEXT,
  "official_entity_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_ai_draft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tbl_ai_draft_user_id_status_created_at_idx"
  ON "tbl_ai_draft"("user_id", "status", "created_at");
CREATE INDEX "tbl_ai_draft_module_code_page_code_status_idx"
  ON "tbl_ai_draft"("module_code", "page_code", "status");
CREATE INDEX "tbl_ai_draft_expires_at_idx"
  ON "tbl_ai_draft"("expires_at");

ALTER TABLE "tbl_ai_model_profile"
  ADD CONSTRAINT "tbl_ai_model_profile_rollback_profile_id_fkey"
  FOREIGN KEY ("rollback_profile_id") REFERENCES "tbl_ai_model_profile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_ai_message"
  ADD CONSTRAINT "tbl_ai_message_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "tbl_ai_conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_message"
  ADD CONSTRAINT "tbl_ai_message_model_profile_id_fkey"
  FOREIGN KEY ("model_profile_id") REFERENCES "tbl_ai_model_profile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_ai_request"
  ADD CONSTRAINT "tbl_ai_request_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "tbl_ai_conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_request"
  ADD CONSTRAINT "tbl_ai_request_user_message_id_fkey"
  FOREIGN KEY ("user_message_id") REFERENCES "tbl_ai_message"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_request"
  ADD CONSTRAINT "tbl_ai_request_assistant_message_id_fkey"
  FOREIGN KEY ("assistant_message_id") REFERENCES "tbl_ai_message"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_request"
  ADD CONSTRAINT "tbl_ai_request_model_profile_id_fkey"
  FOREIGN KEY ("model_profile_id") REFERENCES "tbl_ai_model_profile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tbl_ai_capability_call"
  ADD CONSTRAINT "tbl_ai_capability_call_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "tbl_ai_conversation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_capability_call"
  ADD CONSTRAINT "tbl_ai_capability_call_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "tbl_ai_request"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tbl_ai_draft"
  ADD CONSTRAINT "tbl_ai_draft_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "tbl_ai_conversation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_draft"
  ADD CONSTRAINT "tbl_ai_draft_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "tbl_ai_request"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tbl_ai_draft"
  ADD CONSTRAINT "tbl_ai_draft_capability_call_id_fkey"
  FOREIGN KEY ("capability_call_id") REFERENCES "tbl_ai_capability_call"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
