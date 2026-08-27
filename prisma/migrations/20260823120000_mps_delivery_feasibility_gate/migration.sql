ALTER TABLE "tbl_mps"
  ADD COLUMN "delivery_feasibility_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "delivery_disposition_status" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "official_gate_status" TEXT NOT NULL DEFAULT 'BLOCKED',
  ADD COLUMN "delivery_feasibility_checked_at" TIMESTAMP(3),
  ADD COLUMN "delivery_feasibility_fingerprint" TEXT,
  ADD COLUMN "delivery_feasibility_reason" TEXT;

ALTER TABLE "tbl_due_date_recovery_plan"
  ADD COLUMN "decision_type" TEXT NOT NULL DEFAULT 'RECOVERY',
  ADD COLUMN "original_delivery_date" TIMESTAMP(3),
  ADD COLUMN "accepted_delivery_date" TIMESTAMP(3),
  ADD COLUMN "accept_late_reason" TEXT;

CREATE TABLE "tbl_mps_delivery_feasibility_snapshot" (
  "id" TEXT NOT NULL,
  "mps_id" TEXT NOT NULL,
  "mps_revision" INTEGER NOT NULL,
  "delivery_target_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_number" TEXT NOT NULL,
  "source_line_id" TEXT,
  "part_code" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "original_target_date" TIMESTAMP(3) NOT NULL,
  "effective_commitment_date" TIMESTAMP(3),
  "feasibility_status" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "disposition_status" TEXT NOT NULL DEFAULT 'NONE',
  "official_gate_status" TEXT NOT NULL DEFAULT 'BLOCKED',
  "recovery_plan_id" TEXT,
  "recovery_plan_revision" INTEGER,
  "accept_late_new_date" TIMESTAMP(3),
  "accept_late_reason" TEXT,
  "decision_approved_by" TEXT,
  "decision_approved_at" TIMESTAMP(3),
  "target_updated_at" TIMESTAMP(3),
  "decision_updated_at" TIMESTAMP(3),
  "recovery_updated_at" TIMESTAMP(3),
  "source_fingerprint" TEXT NOT NULL,
  "assessment_detail" JSONB,
  "assessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tbl_mps_delivery_feasibility_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_mps_delivery_feasibility_snapshot_mps_id_mps_revision_delivery_target_id_key"
  ON "tbl_mps_delivery_feasibility_snapshot"("mps_id", "mps_revision", "delivery_target_id");
CREATE INDEX "tbl_mps_delivery_feasibility_snapshot_mps_id_mps_revision_idx"
  ON "tbl_mps_delivery_feasibility_snapshot"("mps_id", "mps_revision");
CREATE INDEX "tbl_mps_delivery_feasibility_snapshot_delivery_target_id_idx"
  ON "tbl_mps_delivery_feasibility_snapshot"("delivery_target_id");
CREATE INDEX "tbl_mps_delivery_feasibility_snapshot_feasibility_status_official_gate_status_idx"
  ON "tbl_mps_delivery_feasibility_snapshot"("feasibility_status", "official_gate_status");

ALTER TABLE "tbl_mps_delivery_feasibility_snapshot"
  ADD CONSTRAINT "tbl_mps_delivery_feasibility_snapshot_mps_id_fkey"
  FOREIGN KEY ("mps_id") REFERENCES "tbl_mps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
