-- AlterTable
ALTER TABLE "tbl_work_order" ADD COLUMN     "work_center_code" TEXT;

-- CreateTable
CREATE TABLE "tbl_work_center" (
    "id" TEXT NOT NULL,
    "work_center_code" TEXT NOT NULL,
    "work_center_name" TEXT NOT NULL,
    "description" TEXT,
    "department_code" TEXT,
    "capacity_type" TEXT,
    "capacity_per_shift" DOUBLE PRECISION,
    "shift_count" INTEGER NOT NULL DEFAULT 1,
    "machine_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_work_center_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_work_center_work_center_code_key" ON "tbl_work_center"("work_center_code");

-- CreateIndex
CREATE INDEX "tbl_work_center_work_center_code_idx" ON "tbl_work_center"("work_center_code");

-- CreateIndex
CREATE INDEX "tbl_work_center_department_code_idx" ON "tbl_work_center"("department_code");

-- CreateIndex
CREATE INDEX "tbl_work_center_machine_code_idx" ON "tbl_work_center"("machine_code");

-- CreateIndex
CREATE INDEX "tbl_work_center_status_idx" ON "tbl_work_center"("status");

-- CreateIndex
CREATE INDEX "tbl_work_center_is_deleted_idx" ON "tbl_work_center"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_work_order_work_center_code_idx" ON "tbl_work_order"("work_center_code");

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_work_center_code_fkey" FOREIGN KEY ("work_center_code") REFERENCES "tbl_work_center"("work_center_code") ON DELETE SET NULL ON UPDATE CASCADE;
