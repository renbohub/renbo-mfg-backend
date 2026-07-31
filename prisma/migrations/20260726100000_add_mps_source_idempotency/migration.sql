-- Nullable key preserves all legacy MPS rows, including historical duplicates.
-- New Forecast -> MPS documents receive a deterministic key and cannot be
-- inserted twice by retrying or concurrently submitting the same month.
ALTER TABLE "tbl_mps"
ADD COLUMN "source_key" TEXT;

CREATE UNIQUE INDEX "tbl_mps_source_key_key"
ON "tbl_mps"("source_key");

CREATE INDEX "tbl_mps_source_key_idx"
ON "tbl_mps"("source_key");
