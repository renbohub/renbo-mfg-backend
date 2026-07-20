CREATE TABLE IF NOT EXISTS "tbl_mbom_draft" (
  "id" TEXT NOT NULL,
  "draft_number" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "created_by" TEXT,
  "updated_by" TEXT,
  "approved_by" TEXT,
  "approved_no_reg" TEXT,
  "approved_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_mbom_draft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tbl_mbom_draft_draft_number_key" ON "tbl_mbom_draft"("draft_number");
CREATE INDEX IF NOT EXISTS "tbl_mbom_draft_status_idx" ON "tbl_mbom_draft"("status");
CREATE INDEX IF NOT EXISTS "tbl_mbom_draft_created_by_idx" ON "tbl_mbom_draft"("created_by");
CREATE INDEX IF NOT EXISTS "tbl_mbom_draft_is_deleted_idx" ON "tbl_mbom_draft"("is_deleted");
