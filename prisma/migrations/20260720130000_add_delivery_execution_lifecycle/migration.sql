-- Wave 8 delivery execution lifecycle. Existing schedules and statuses remain valid.
ALTER TABLE "tbl_delivery_schedule"
  ADD COLUMN IF NOT EXISTS "picked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "packed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "shipped_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vehicle" TEXT,
  ADD COLUMN IF NOT EXISTS "driver" TEXT,
  ADD COLUMN IF NOT EXISTS "carrier" TEXT,
  ADD COLUMN IF NOT EXISTS "pod_url" TEXT,
  ADD COLUMN IF NOT EXISTS "failure_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "returned_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;
