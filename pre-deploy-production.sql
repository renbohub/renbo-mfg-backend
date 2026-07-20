-- ============================================================
-- PRE-DEPLOY SCRIPT UNTUK PRODUCTION
-- Jalankan script ini SEBELUM `prisma migrate deploy`
-- Aman: menggunakan IF NOT EXISTS dan conditional checks
-- ============================================================

-- ============================================================
-- STEP 1: Fix checksum migration yang dimodifikasi
-- ============================================================
UPDATE "_prisma_migrations"
SET checksum = '3fc3e3407a73030973f7432a8d164a72698ef613b10535ac690a1ff5f642974c'
WHERE migration_name = '20260204061112_add_inventory_planning_modules';

UPDATE "_prisma_migrations"
SET checksum = '4bffacbbd4aff41d2f93649a37b02c07d284dd3edd9a9ba5d340399cb417a2fa'
WHERE migration_name = '20260303121252_new_bom_to_mbom';

-- ============================================================
-- STEP 2: Rename level_bom → level_mbom (jika belum)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_mrp_requirement' AND column_name = 'level_bom'
  ) THEN
    DROP INDEX IF EXISTS "tbl_mrp_requirement_level_bom_idx";
    ALTER TABLE "tbl_mrp_requirement" RENAME COLUMN "level_bom" TO "level_mbom";
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "tbl_mrp_requirement_level_mbom_idx" ON "tbl_mrp_requirement"("level_mbom");

-- ============================================================
-- STEP 3: Tambah kolom baru di EBOM/MBOM Cost tables
-- ============================================================
ALTER TABLE "tbl_ebomcost_header" ADD COLUMN IF NOT EXISTS "cost_per_unit" DOUBLE PRECISION;
ALTER TABLE "tbl_ebomcost_header" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "tbl_ebomcost_header" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "tbl_ebomcost_header_is_deleted_idx" ON "tbl_ebomcost_header"("is_deleted");

ALTER TABLE "tbl_ebomcost_detail" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "tbl_ebomcost_detail_is_deleted_idx" ON "tbl_ebomcost_detail"("is_deleted");

ALTER TABLE "tbl_mbomcost_header" ADD COLUMN IF NOT EXISTS "cost_per_unit" DOUBLE PRECISION;
ALTER TABLE "tbl_mbomcost_header" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "tbl_mbomcost_header" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "tbl_mbomcost_header_is_deleted_idx" ON "tbl_mbomcost_header"("is_deleted");

ALTER TABLE "tbl_mbomcost_detail" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "tbl_mbomcost_detail_is_deleted_idx" ON "tbl_mbomcost_detail"("is_deleted");

-- ============================================================
-- STEP 4: Rename bom_id → ebom_id di tbl_ebomcost_header
--         (data-preserving, conditional)
-- ============================================================
DO $$
BEGIN
  -- Hanya rename jika kolom bom_id masih ada
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tbl_ebomcost_header' AND column_name = 'bom_id'
  ) THEN
    -- Drop FK constraint lama
    ALTER TABLE "tbl_ebomcost_header" DROP CONSTRAINT IF EXISTS "tbl_ebomcost_header_bom_id_fkey";
    -- Drop index lama
    DROP INDEX IF EXISTS "tbl_ebomcost_header_bom_id_idx";
    -- Rename kolom (data tetap aman)
    ALTER TABLE "tbl_ebomcost_header" RENAME COLUMN "bom_id" TO "ebom_id";
    -- Recreate index baru
    CREATE INDEX IF NOT EXISTS "tbl_ebomcost_header_ebom_id_idx" ON "tbl_ebomcost_header"("ebom_id");
    -- Recreate FK baru
    ALTER TABLE "tbl_ebomcost_header"
      ADD CONSTRAINT "tbl_ebomcost_header_ebom_id_fkey"
      FOREIGN KEY ("ebom_id") REFERENCES "tbl_ebomheader"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================================
-- STEP 5: Daftarkan migration baru ke _prisma_migrations
--         agar migrate deploy tidak mencoba apply ulang
-- ============================================================

-- Migration: 20260304000001_fix_schema_drift_v2
INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
SELECT
  gen_random_uuid()::text,
  '5992503b655ec1c376d3f484aecf28835f7e36735f7136f1740e002ee492161c',
  NOW(),
  '20260304000001_fix_schema_drift_v2',
  NULL,
  NULL,
  NOW(),
  1
WHERE NOT EXISTS (
  SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260304000001_fix_schema_drift_v2'
);

-- Migration: 20260304135016_new2
INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
SELECT
  gen_random_uuid()::text,
  '730bf04f290257c9e53825dbd215c1727a52ab108dc68296703067820faf9b79',
  NOW(),
  '20260304135016_new2',
  NULL,
  NULL,
  NOW(),
  1
WHERE NOT EXISTS (
  SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260304135016_new2'
);

-- ============================================================
-- SELESAI
-- Setelah script ini berhasil, jalankan: npx prisma migrate deploy
-- Hasilnya harus: "All migrations have been successfully applied"
-- ============================================================
