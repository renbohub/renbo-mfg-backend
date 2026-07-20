-- DropForeignKey: hapus relasi rack → warehouse
ALTER TABLE "tbl_rack" DROP CONSTRAINT IF EXISTS "tbl_rack_warehouse_code_fkey";

-- DropIndex
DROP INDEX IF EXISTS "tbl_rack_warehouse_code_idx";

-- AlterTable: hapus kolom warehouse_code dari tbl_rack
ALTER TABLE "tbl_rack" DROP COLUMN IF EXISTS "warehouse_code";
