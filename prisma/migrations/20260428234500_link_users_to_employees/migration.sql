-- AlterTable
ALTER TABLE "tbl_users" ADD COLUMN "employee_id" TEXT;

-- AlterTable
ALTER TABLE "tbl_employee" ADD COLUMN "profile_photo" TEXT;
ALTER TABLE "tbl_employee" ADD COLUMN "signature" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tbl_users_employee_id_key" ON "tbl_users"("employee_id");

-- CreateIndex
CREATE INDEX "tbl_users_employee_id_idx" ON "tbl_users"("employee_id");

-- AddForeignKey
ALTER TABLE "tbl_users" ADD CONSTRAINT "tbl_users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "tbl_employee"("employee_id") ON DELETE SET NULL ON UPDATE CASCADE;
