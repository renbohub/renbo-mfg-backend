ALTER TABLE "tbl_downtime_log"
  ADD COLUMN "hmi_downtime_id" INTEGER,
  ADD COLUMN "hmi_downtime_sub_id" INTEGER;

CREATE TABLE "tbl_production_log_ng_reason" (
  "id" TEXT NOT NULL,
  "production_log_id" TEXT NOT NULL,
  "coil_phase_id" TEXT NOT NULL,
  "phase_number" INTEGER NOT NULL,
  "hmi_rejection_id" INTEGER,
  "hmi_rejection_sub_id" INTEGER,
  "reason" TEXT NOT NULL,
  "sub_reason" TEXT,
  "qty_ng" DOUBLE PRECISION NOT NULL,
  "qty_rework" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PENDING_QC',
  "qc_notes" TEXT,
  "judged_by" TEXT,
  "judged_at" TIMESTAMP(3),
  "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_production_log_ng_reason_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_production_log_ng_reason_production_log_id_fkey"
    FOREIGN KEY ("production_log_id") REFERENCES "tbl_production_log"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tbl_production_log_ng_reason_coil_phase_id_fkey"
    FOREIGN KEY ("coil_phase_id") REFERENCES "tbl_production_log_coil_phase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tbl_production_log_ng_reason_production_log_id_idx"
  ON "tbl_production_log_ng_reason"("production_log_id");
CREATE INDEX "tbl_production_log_ng_reason_coil_phase_id_phase_number_idx"
  ON "tbl_production_log_ng_reason"("coil_phase_id", "phase_number");
CREATE INDEX "tbl_production_log_ng_reason_status_idx"
  ON "tbl_production_log_ng_reason"("status");
CREATE INDEX "tbl_production_log_ng_reason_is_deleted_idx"
  ON "tbl_production_log_ng_reason"("is_deleted");
