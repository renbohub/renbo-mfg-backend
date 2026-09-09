CREATE TABLE "tbl_eta_confirmation" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_number" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "source_snapshot" JSONB NOT NULL,
  "mps_number" TEXT,
  "mps_revision" INTEGER,
  "partner_code" TEXT NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL CHECK ("qty" > 0),
  "eta" TIMESTAMP(3) NOT NULL,
  "ready_date" TIMESTAMP(3),
  "confirmation_reference" TEXT NOT NULL,
  "notes" TEXT,
  "confirmed_by" TEXT NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_eta_confirmation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tbl_eta_confirmation_dates_check" CHECK ("ready_date" IS NULL OR "ready_date" >= "eta")
);
CREATE UNIQUE INDEX "tbl_eta_confirmation_request_id_key" ON "tbl_eta_confirmation"("request_id");
CREATE INDEX "tbl_eta_confirmation_source_key_confirmed_at_idx" ON "tbl_eta_confirmation"("source_key", "confirmed_at");
CREATE INDEX "tbl_eta_confirmation_mps_number_mps_revision_idx" ON "tbl_eta_confirmation"("mps_number", "mps_revision");
