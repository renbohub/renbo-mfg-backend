-- Fix drift: db push menghapus DEFAULT dari updated_at saat menambah kolom description/product_id.
-- Prisma @updatedAt tidak butuh DB-level DEFAULT, nilainya diset oleh Prisma di runtime.
-- Migration ini menyelaraskan history dengan kondisi DB aktual.
ALTER TABLE "tbl_lot_master" ALTER COLUMN "updated_at" DROP DEFAULT;
