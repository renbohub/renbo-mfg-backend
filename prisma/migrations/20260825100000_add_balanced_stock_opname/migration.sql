ALTER TABLE "tbl_sto_headers"
  ADD COLUMN "count_mode" TEXT NOT NULL DEFAULT 'FULL',
  ADD COLUMN "scope_json" JSONB,
  ADD COLUMN "snapshot_at" TIMESTAMP(3),
  ADD COLUMN "tolerance_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "tolerance_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "current_round_no" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "submitted_by" TEXT,
  ADD COLUMN "submitted_at" TIMESTAMP(3);

ALTER TABLE "tbl_sto_details"
  ADD COLUMN "is_unexpected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "resolution_status" TEXT NOT NULL DEFAULT 'EXPECTED';

CREATE TABLE "tbl_sto_count_rounds" (
  "id" TEXT NOT NULL,
  "sto_header_id" TEXT NOT NULL,
  "round_no" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "request_reason" TEXT,
  "requested_by" TEXT,
  "started_by" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submitted_by" TEXT,
  "submitted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tbl_sto_count_rounds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tbl_sto_count_attempts" (
  "id" TEXT NOT NULL,
  "count_round_id" TEXT NOT NULL,
  "sto_detail_id" TEXT NOT NULL,
  "sequence_no" INTEGER NOT NULL,
  "actual_qty" DOUBLE PRECISION NOT NULL,
  "reason" TEXT,
  "counted_by" TEXT NOT NULL,
  "counted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_sto_count_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tbl_sto_count_rounds_sto_header_id_round_no_key"
  ON "tbl_sto_count_rounds"("sto_header_id", "round_no");
CREATE INDEX "tbl_sto_count_rounds_status_idx"
  ON "tbl_sto_count_rounds"("status");
CREATE UNIQUE INDEX "tbl_sto_count_attempts_count_round_id_sto_detail_id_sequence_no_key"
  ON "tbl_sto_count_attempts"("count_round_id", "sto_detail_id", "sequence_no");
CREATE INDEX "tbl_sto_count_attempts_sto_detail_id_is_current_idx"
  ON "tbl_sto_count_attempts"("sto_detail_id", "is_current");

ALTER TABLE "tbl_sto_count_rounds"
  ADD CONSTRAINT "tbl_sto_count_rounds_sto_header_id_fkey"
  FOREIGN KEY ("sto_header_id") REFERENCES "tbl_sto_headers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_sto_count_attempts"
  ADD CONSTRAINT "tbl_sto_count_attempts_count_round_id_fkey"
  FOREIGN KEY ("count_round_id") REFERENCES "tbl_sto_count_rounds"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_sto_count_attempts"
  ADD CONSTRAINT "tbl_sto_count_attempts_sto_detail_id_fkey"
  FOREIGN KEY ("sto_detail_id") REFERENCES "tbl_sto_details"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;