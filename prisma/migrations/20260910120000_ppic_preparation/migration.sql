CREATE TABLE "tbl_ppic_preparation" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "created_by" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tbl_ppic_preparation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tbl_ppic_preparation_month_updated_at_idx" ON "tbl_ppic_preparation"("month", "updated_at");
