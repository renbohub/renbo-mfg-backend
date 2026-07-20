-- CreateTable
CREATE TABLE "tbl_rack" (
    "id" TEXT NOT NULL,
    "rack_code" TEXT NOT NULL,
    "rack_name" TEXT,
    "warehouse_code" TEXT NOT NULL,
    "zone" TEXT,
    "row" TEXT,
    "level" TEXT,
    "position" TEXT,
    "capacity" DOUBLE PRECISION,
    "capacity_unit" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbl_rack_pkey" PRIMARY KEY ("id")
);

-- AlterTable: tambah rack_code ke stock balance
ALTER TABLE "tbl_stock_balance" ADD COLUMN "rack_code" TEXT;

-- DropIndex: hapus unique constraint lama
DROP INDEX "tbl_stock_balance_warehouse_code_part_code_product_id_descr_key";

-- CreateIndex
CREATE UNIQUE INDEX "tbl_rack_rack_code_key" ON "tbl_rack"("rack_code");
CREATE INDEX "tbl_rack_rack_code_idx" ON "tbl_rack"("rack_code");
CREATE INDEX "tbl_rack_rack_name_idx" ON "tbl_rack"("rack_name");
CREATE INDEX "tbl_rack_warehouse_code_idx" ON "tbl_rack"("warehouse_code");
CREATE INDEX "tbl_rack_zone_idx" ON "tbl_rack"("zone");
CREATE INDEX "tbl_rack_is_active_idx" ON "tbl_rack"("is_active");
CREATE INDEX "tbl_rack_is_deleted_idx" ON "tbl_rack"("is_deleted");

-- CreateIndex: unique constraint baru dengan rack_code
CREATE UNIQUE INDEX "tbl_stock_balance_warehouse_code_rack_code_part_code_produc_key" ON "tbl_stock_balance"("warehouse_code", "rack_code", "part_code", "product_id", "description");

-- CreateIndex: index untuk rack_code di stock_balance
CREATE INDEX "tbl_stock_balance_rack_code_idx" ON "tbl_stock_balance"("rack_code");

-- AddForeignKey
ALTER TABLE "tbl_rack" ADD CONSTRAINT "tbl_rack_warehouse_code_fkey" FOREIGN KEY ("warehouse_code") REFERENCES "tbl_warehouse"("warehouse_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tbl_stock_balance" ADD CONSTRAINT "tbl_stock_balance_rack_code_fkey" FOREIGN KEY ("rack_code") REFERENCES "tbl_rack"("rack_code") ON DELETE SET NULL ON UPDATE CASCADE;
