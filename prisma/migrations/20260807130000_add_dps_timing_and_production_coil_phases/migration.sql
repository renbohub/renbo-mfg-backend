ALTER TABLE "tbl_daily_production_schedule"
  ADD COLUMN "planned_start_time" TEXT,
  ADD COLUMN "planned_end_time" TEXT,
  ADD COLUMN "delivery_phase_id" TEXT,
  ADD COLUMN "delivery_phase_number" INTEGER,
  ADD COLUMN "transfer_batch_number" INTEGER,
  ADD COLUMN "predecessor_allocation_ids" JSONB;

CREATE INDEX "tbl_daily_production_schedule_delivery_phase_id_idx"
  ON "tbl_daily_production_schedule"("delivery_phase_id");

CREATE TABLE "tbl_production_log_coil_phase" (
  "id" TEXT NOT NULL,
  "production_log_id" TEXT NOT NULL,
  "phase_number" INTEGER NOT NULL,
  "coil_number" TEXT,
  "input_lot_number" TEXT NOT NULL,
  "qty_input" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_good" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "qty_reject" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "production_lot_number" TEXT NOT NULL,
  "started_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "notes" TEXT,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_production_log_coil_phase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_production_log_coil_phase_production_log_id_fkey"
    FOREIGN KEY ("production_log_id") REFERENCES "tbl_production_log"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tbl_production_log_coil_phase_production_log_id_phase_number_idx"
  ON "tbl_production_log_coil_phase"("production_log_id", "phase_number");
CREATE INDEX "tbl_production_log_coil_phase_input_lot_number_idx"
  ON "tbl_production_log_coil_phase"("input_lot_number");
CREATE INDEX "tbl_production_log_coil_phase_production_lot_number_idx"
  ON "tbl_production_log_coil_phase"("production_lot_number");
CREATE INDEX "tbl_production_log_coil_phase_is_deleted_idx"
  ON "tbl_production_log_coil_phase"("is_deleted");
