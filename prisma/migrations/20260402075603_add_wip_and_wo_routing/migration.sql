-- AlterTable
ALTER TABLE "tbl_work_order" ADD COLUMN     "cycle_time" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "process_id" TEXT,
ADD COLUMN     "sequence" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tbl_wip_entry" (
    "id" TEXT NOT NULL,
    "entry_number" TEXT NOT NULL,
    "entry_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mo_id" TEXT NOT NULL,
    "wo_id" TEXT,
    "cost_type" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "source_ref" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "direction" TEXT NOT NULL DEFAULT 'IN',
    "notes" TEXT,
    "created_by" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_wip_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tbl_wip_entry_entry_number_key" ON "tbl_wip_entry"("entry_number");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_entry_number_idx" ON "tbl_wip_entry"("entry_number");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_mo_id_idx" ON "tbl_wip_entry"("mo_id");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_wo_id_idx" ON "tbl_wip_entry"("wo_id");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_cost_type_idx" ON "tbl_wip_entry"("cost_type");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_source_type_idx" ON "tbl_wip_entry"("source_type");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_direction_idx" ON "tbl_wip_entry"("direction");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_entry_date_idx" ON "tbl_wip_entry"("entry_date");

-- CreateIndex
CREATE INDEX "tbl_wip_entry_is_deleted_idx" ON "tbl_wip_entry"("is_deleted");

-- CreateIndex
CREATE INDEX "tbl_work_order_process_id_idx" ON "tbl_work_order"("process_id");

-- CreateIndex
CREATE INDEX "tbl_work_order_sequence_idx" ON "tbl_work_order"("sequence");

-- AddForeignKey
ALTER TABLE "tbl_work_order" ADD CONSTRAINT "tbl_work_order_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "tbl_process"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_wip_entry" ADD CONSTRAINT "tbl_wip_entry_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "tbl_manufacturing_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_wip_entry" ADD CONSTRAINT "tbl_wip_entry_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "tbl_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
