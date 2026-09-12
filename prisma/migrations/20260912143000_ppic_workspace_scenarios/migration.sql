CREATE TABLE "tbl_ppic_workspace_scenario" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "source_identifier" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "source_data_fingerprint" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ppic_workspace_month_check" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "ppic_workspace_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "ppic_workspace_draft_status_check" CHECK ("status" = 'DRAFT')
);
CREATE INDEX "ppic_workspace_scenario_month_updated_idx" ON "tbl_ppic_workspace_scenario" ("month", "updated_at");

CREATE TABLE "tbl_ppic_workspace_scenario_operation" (
  "operation_id" TEXT NOT NULL PRIMARY KEY,
  "scenario_id" TEXT NOT NULL REFERENCES "tbl_ppic_workspace_scenario"("id") ON DELETE RESTRICT,
  "request_hash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ppic_workspace_operation_revision_unique" UNIQUE ("scenario_id", "revision")
);
CREATE INDEX "ppic_workspace_operation_scenario_idx" ON "tbl_ppic_workspace_scenario_operation" ("scenario_id", "created_at");
