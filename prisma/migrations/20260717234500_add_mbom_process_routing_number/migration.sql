ALTER TABLE "tbl_mbomprocess" ADD COLUMN "routing_number" TEXT;

CREATE INDEX "tbl_mbomprocess_routing_number_idx" ON "tbl_mbomprocess"("routing_number");
