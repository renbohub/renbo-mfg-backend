CREATE TABLE "tbl_monthly_demand_snapshot" (
  "id" TEXT NOT NULL,
  "snapshot_number" TEXT NOT NULL,
  "period_year" INTEGER NOT NULL,
  "period_month" INTEGER NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "cutoff_date" TIMESTAMP(3) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "base_snapshot_id" TEXT,
  "is_current_revision" BOOLEAN NOT NULL DEFAULT true,
  "source_data_as_of" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_fingerprint" TEXT NOT NULL,
  "part_count" INTEGER NOT NULL DEFAULT 0,
  "blocked_count" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "total_fcc_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total_po_firm_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total_consumed_fcc_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total_unplanned_po_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total_eff_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_by" TEXT,
  "updated_by" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "approved_by" TEXT,
  "approved_at" TIMESTAMP(3),
  "frozen_by" TEXT,
  "frozen_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_monthly_demand_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_monthly_demand_snapshot_detail" (
  "id" TEXT NOT NULL,
  "snapshot_id" TEXT NOT NULL,
  "line_number" INTEGER NOT NULL,
  "part_code" TEXT NOT NULL,
  "part_number" TEXT,
  "part_name" TEXT,
  "customer_codes" JSONB NOT NULL DEFAULT '[]',
  "uom_code" TEXT,
  "planning_policy" TEXT,
  "fcc_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "po_firm_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "consumed_fcc_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "po_effective_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unplanned_po_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "eff_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "delta_fcc_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "delta_po_firm_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "delta_eff_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "delivery_phase_count" INTEGER NOT NULL DEFAULT 0,
  "readiness_status" TEXT NOT NULL DEFAULT 'READY',
  "readiness_issues" JSONB NOT NULL DEFAULT '[]',
  "source_trace" JSONB NOT NULL DEFAULT '{}',
  "source_updated_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_monthly_demand_snapshot_detail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_monthly_demand_snapshot_detail_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "tbl_monthly_demand_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "tbl_monthly_demand_snapshot_action" (
  "id" TEXT NOT NULL,
  "snapshot_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT,
  "reason" TEXT,
  "actor" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_monthly_demand_snapshot_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_monthly_demand_snapshot_action_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "tbl_monthly_demand_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tbl_monthly_demand_snapshot_snapshot_number_key" ON "tbl_monthly_demand_snapshot"("snapshot_number");
CREATE UNIQUE INDEX "tbl_monthly_demand_snapshot_period_year_period_month_revision_key" ON "tbl_monthly_demand_snapshot"("period_year", "period_month", "revision");
CREATE INDEX "tbl_monthly_demand_snapshot_period_year_period_month_idx" ON "tbl_monthly_demand_snapshot"("period_year", "period_month");
CREATE INDEX "tbl_monthly_demand_snapshot_status_is_deleted_idx" ON "tbl_monthly_demand_snapshot"("status", "is_deleted");
CREATE INDEX "tbl_monthly_demand_snapshot_is_current_revision_idx" ON "tbl_monthly_demand_snapshot"("is_current_revision");
CREATE UNIQUE INDEX "tbl_monthly_demand_snapshot_detail_snapshot_id_part_code_key" ON "tbl_monthly_demand_snapshot_detail"("snapshot_id", "part_code");
CREATE INDEX "tbl_monthly_demand_snapshot_detail_part_code_idx" ON "tbl_monthly_demand_snapshot_detail"("part_code");
CREATE INDEX "tbl_monthly_demand_snapshot_detail_readiness_status_idx" ON "tbl_monthly_demand_snapshot_detail"("readiness_status");
CREATE INDEX "tbl_monthly_demand_snapshot_action_snapshot_id_created_at_idx" ON "tbl_monthly_demand_snapshot_action"("snapshot_id", "created_at");
