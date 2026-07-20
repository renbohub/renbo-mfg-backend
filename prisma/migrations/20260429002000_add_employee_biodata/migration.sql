-- Add employee biodata fields for HR profile and retirement calculation.
ALTER TABLE "tbl_employee"
  ADD COLUMN "national_id" TEXT,
  ADD COLUMN "birth_place" TEXT,
  ADD COLUMN "birth_date" TIMESTAMP(3),
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "marital_status" TEXT,
  ADD COLUMN "religion" TEXT,
  ADD COLUMN "blood_type" TEXT,
  ADD COLUMN "height_cm" INTEGER,
  ADD COLUMN "weight_kg" INTEGER,
  ADD COLUMN "address" TEXT;

CREATE INDEX "tbl_employee_national_id_idx" ON "tbl_employee"("national_id");
CREATE INDEX "tbl_employee_birth_date_idx" ON "tbl_employee"("birth_date");
