ALTER TABLE "tbl_incoming_inspection_detail"
  ADD COLUMN "qty_accepted_putaway" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "qty_rejected_disposed" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "rejected_disposition" TEXT,
  ADD COLUMN "disposition_reference" TEXT,
  ADD COLUMN "disposed_by" TEXT,
  ADD COLUMN "disposed_at" TIMESTAMP(3);
