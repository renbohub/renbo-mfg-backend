CREATE TABLE IF NOT EXISTS "tbl_employee_division" (
  "id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "division_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tbl_employee_division_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tbl_employee_division_employee_id_division_id_key"
  ON "tbl_employee_division"("employee_id", "division_id");

CREATE INDEX IF NOT EXISTS "tbl_employee_division_employee_id_idx"
  ON "tbl_employee_division"("employee_id");

CREATE INDEX IF NOT EXISTS "tbl_employee_division_division_id_idx"
  ON "tbl_employee_division"("division_id");

ALTER TABLE "tbl_employee_division"
  ADD CONSTRAINT "tbl_employee_division_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "tbl_employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tbl_employee_division"
  ADD CONSTRAINT "tbl_employee_division_division_id_fkey"
  FOREIGN KEY ("division_id") REFERENCES "tbl_division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "tbl_employee_division" ("id", "employee_id", "division_id")
SELECT md5(e."id" || ':' || e."division_id"), e."id", e."division_id"
FROM "tbl_employee" e
WHERE e."division_id" IS NOT NULL
ON CONFLICT ("employee_id", "division_id") DO NOTHING;
