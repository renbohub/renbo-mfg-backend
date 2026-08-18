CREATE TABLE "tbl_demand_exception" (
  "id" TEXT NOT NULL,
  "exception_number" TEXT NOT NULL,
  "identity_key" TEXT NOT NULL,
  "period_year" INTEGER NOT NULL,
  "period_month" INTEGER NOT NULL,
  "source_mode" TEXT NOT NULL DEFAULT 'LIVE',
  "source_snapshot_id" TEXT,
  "source_snapshot_number" TEXT,
  "source_fingerprint" TEXT,
  "source_detail_id" TEXT,
  "source_delivery_target_id" TEXT,
  "source_type" TEXT,
  "source_number" TEXT,
  "source_line_id" TEXT,
  "phase_number" INTEGER,
  "customer_code" TEXT,
  "part_code" TEXT NOT NULL,
  "part_number" TEXT,
  "part_name" TEXT,
  "demand_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "uom_code" TEXT,
  "target_delivery_date" TIMESTAMP(3),
  "production_latest_start_date" TIMESTAMP(3),
  "exception_type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'P2',
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "source_active" BOOLEAN NOT NULL DEFAULT true,
  "source_cleared_at" TIMESTAMP(3),
  "owner_user_id" TEXT,
  "owner_username" TEXT,
  "owner_name" TEXT,
  "target_resolution_date" TIMESTAMP(3),
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_by" TEXT,
  "acknowledged_at" TIMESTAMP(3),
  "resolved_by" TEXT,
  "resolved_at" TIMESTAMP(3),
  "resolution_summary" TEXT,
  "resolution_evidence" JSONB,
  "closed_by" TEXT,
  "closed_at" TIMESTAMP(3),
  "source_trace" JSONB NOT NULL DEFAULT '{}',
  "created_by" TEXT,
  "updated_by" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_demand_exception_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_demand_exception_action" (
  "id" TEXT NOT NULL,
  "exception_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT,
  "note" TEXT,
  "actor" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_demand_exception_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_demand_exception_action_exception_id_fkey" FOREIGN KEY ("exception_id") REFERENCES "tbl_demand_exception"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_demand_exception_exception_number_key" ON "tbl_demand_exception"("exception_number");
CREATE UNIQUE INDEX "tbl_demand_exception_identity_key_key" ON "tbl_demand_exception"("identity_key");
CREATE INDEX "tbl_demand_exception_period_year_period_month_source_active_idx" ON "tbl_demand_exception"("period_year", "period_month", "source_active");
CREATE INDEX "tbl_demand_exception_status_severity_priority_idx" ON "tbl_demand_exception"("status", "severity", "priority");
CREATE INDEX "tbl_demand_exception_owner_user_id_status_idx" ON "tbl_demand_exception"("owner_user_id", "status");
CREATE INDEX "tbl_demand_exception_part_code_target_delivery_date_idx" ON "tbl_demand_exception"("part_code", "target_delivery_date");
CREATE INDEX "tbl_demand_exception_source_delivery_target_id_idx" ON "tbl_demand_exception"("source_delivery_target_id");
CREATE INDEX "tbl_demand_exception_target_resolution_date_idx" ON "tbl_demand_exception"("target_resolution_date");
CREATE INDEX "tbl_demand_exception_is_deleted_idx" ON "tbl_demand_exception"("is_deleted");
CREATE INDEX "tbl_demand_exception_action_exception_id_created_at_idx" ON "tbl_demand_exception_action"("exception_id", "created_at");
