-- Context columns are nullable so every legacy log remains valid.
ALTER TABLE "tbl_logs"
  ADD COLUMN IF NOT EXISTS "module_code" TEXT,
  ADD COLUMN IF NOT EXISTS "page_code" TEXT,
  ADD COLUMN IF NOT EXISTS "record_key" TEXT,
  ADD COLUMN IF NOT EXISTS "log_type" TEXT NOT NULL DEFAULT 'ACTIVITY';

CREATE INDEX IF NOT EXISTS "tbl_logs_log_type_created_at_idx"
  ON "tbl_logs"("log_type", "created_at");

CREATE INDEX IF NOT EXISTS "tbl_logs_module_code_page_code_record_key_created_at_idx"
  ON "tbl_logs"("module_code", "page_code", "record_key", "created_at");

CREATE TABLE IF NOT EXISTS "tbl_page_comments" (
  "id" TEXT NOT NULL,
  "module_code" TEXT NOT NULL,
  "page_code" TEXT NOT NULL,
  "record_key" TEXT,
  "message" TEXT NOT NULL,
  "user_id" TEXT,
  "username" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_page_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "tbl_page_comments_module_code_page_code_record_key_created_at_idx"
  ON "tbl_page_comments"("module_code", "page_code", "record_key", "created_at");

CREATE INDEX IF NOT EXISTS "tbl_page_comments_user_id_idx"
  ON "tbl_page_comments"("user_id");

CREATE INDEX IF NOT EXISTS "tbl_page_comments_is_deleted_idx"
  ON "tbl_page_comments"("is_deleted");
